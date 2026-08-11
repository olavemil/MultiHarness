import { createCliAdapter } from "../adapters/cli.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config/schema.ts";
import { loadConfig } from "../config/load.ts";
import type { Identity, InboundMessage } from "../core/types.ts";
import { continuationTrigger, maintenanceTrigger, messageTrigger } from "../core/trigger.ts";
import { detectMention } from "../core/mentions.ts";
import { interjectDelay } from "../core/participation.ts";
import { pendingMaintenance } from "../session/maintenance.ts";
import { shouldContinue, type ProgressDelta } from "../session/continuation.ts";
import type { Plan } from "../store/planStore.ts";
import { runSession } from "../session/run.ts";
import { turnQueueDepth, withTurn } from "../session/turn.ts";
import { appendMessage, readRecent } from "../store/channelStore.ts";
import { appendReaction, readReactions } from "../store/reactionStore.ts";
import { loadIdentity } from "../store/identityStore.ts";
import { ensurePaths, resolvePaths } from "../store/paths.ts";
import type { InstanceRef } from "./discover.ts";
import { readInstanceEnv, type Env } from "./env.ts";
import { createLogger, type Logger } from "./log.ts";

const HISTORY_LIMIT = 40;

/**
 * One agent, running.
 *
 * Everything an instance touches is reached through its own `config`, `paths`,
 * `env`, and `log` — no module-level state, and nothing read from the process
 * environment after startup. That is what lets several of them share a process
 * without sharing anything else, which is the property worth protecting: a
 * shared daemon makes it *easy* to accidentally couple two agents, and they have
 * no business knowing the other exists.
 */
export interface RunningInstance {
  name: string;
  config: Config;
  /** Resolves when this instance's transport has ended its input. */
  closed(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Slack when it is configured, otherwise the console. Tokens come from the
 * instance's own scoped environment and never from config; a missing one is a
 * startup error rather than a silent fallback to stdin, which would look like
 * the adapter working.
 */
async function selectAdapter(
  ref: InstanceRef,
  config: Config,
  env: Env,
  shareConsole: boolean,
  log: Logger,
): Promise<Adapter> {
  if (!config.slack.enabled) {
    // Labelled only when it has company: with one agent the prefix is noise,
    // and with two an unlabelled reply is unattributable.
    return createCliAdapter(shareConsole ? { label: ref.name } : {});
  }

  const botToken = env["SLACK_BOT_TOKEN"];
  const appToken = env["SLACK_APP_TOKEN"];
  if (!botToken || !appToken) {
    throw new Error(
      `[slack] enabled but SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not both set for ` +
        `${ref.name}. They belong in ${ref.home}/.env — the bot token starts xoxb-, ` +
        `the app-level token for Socket Mode starts xapp-.`,
    );
  }

  // Imported lazily so the console-only path does not pay for Bolt's dependency tree.
  const { createSlackAdapter } = await import("../adapters/slack/index.ts");
  return createSlackAdapter({
    botToken,
    appToken,
    threadMode: config.slack.thread_mode,
    agentName: config.agent.name,
    log: log.scoped("slack"),
  });
}

export interface StartOptions {
  /**
   * Whether this instance is sharing the process with others. Only affects
   * presentation — an instance is never told who the others are.
   */
  shareConsole?: boolean;
}

/**
 * Starts one agent and returns a handle on it.
 *
 * The harness runs headless. Adapters attach and detach; nothing about the
 * agent's lifetime is tied to any one of them being connected.
 */
export async function startInstance(
  ref: InstanceRef,
  baseLog: Logger = createLogger(ref.name),
  options: StartOptions = {},
): Promise<RunningInstance> {
  // Read into a scoped object, never into `process.env`: two instances loading
  // their `.env` files globally would overwrite each other's tokens and both
  // connect as whichever loaded last.
  const env = await readInstanceEnv(ref.home);

  const config = await loadConfig(undefined, ref.home, (message) => baseLog.warn(message));
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const adapter: Adapter = await selectAdapter(
    ref,
    config,
    env,
    options.shareConsole ?? false,
    baseLog,
  );
  const log = baseLog.scoped(adapter.id);

  /**
   * One queue per channel, drained independently.
   *
   * Sessions used to run one at a time *globally*, so a message in one channel
   * waited behind a five-minute research session in another — the worst
   * property of the system with Slack connected and several channels live.
   * Within a channel they stay strictly serial, because per-channel history,
   * reflection, and the last-session pointer all assume one writer.
   */
  interface Channel {
    inbox: InboundMessage[];
    draining?: Promise<void> | undefined;
    /** Last identity seen here, so an idle run knows whose impressions to work on. */
    lastIdentity?: Identity | undefined;
    /** When this channel last did anything, for the idle trigger. */
    lastActivity: number;
  }

  const channels = new Map<string, Channel>();

  const channelOf = (id: string): Channel => {
    let existing = channels.get(id);
    if (!existing) {
      existing = { inbox: [], lastActivity: Date.now() };
      channels.set(id, existing);
    }
    return existing;
  };

  async function handle(message: InboundMessage): Promise<void> {
    const channelForTurn = channelOf(message.channelId);

    // Queued behind another session. Said before the wait rather than after it,
    // because a person watching a channel cannot tell a queue from a dead
    // daemon, and the wait is now a whole session rather than a few seconds.
    if (turnQueueDepth() > 0) adapter.status?.(message.channelId, "queued");

    return withTurn(
      async (waitedMs, ahead) => {
        if (waitedMs > 1_000) {
          log.log(
            `waited ${Math.round(waitedMs / 1000)}s for a turn ` +
              `(${ahead} ahead) before handling a message in ${message.channelId}`,
          );
        }
        await handleWithTurn(message, channelForTurn, waitedMs);
      },
      { size: config.session.turn.size },
    );
  }

  /**
   * The session itself, with the daemon-wide turn already held.
   *
   * Everything that reads state happens *inside* the turn deliberately: the
   * whole point of waiting is that the world may have changed, and a history
   * read from before the wait would describe a conversation that has since been
   * answered.
   */
  async function handleWithTurn(
    message: InboundMessage,
    channel: Channel,
    queuedMs: number,
  ): Promise<void> {
    // History is read before the triggering message is appended, so a step's
    // `recent_messages` block never contains the message it is reacting to.
    const stored = await readRecent(paths, message.channelId, HISTORY_LIMIT);
    const identity = await loadIdentity(paths, message.identityId, message.authorName);
    // Read alongside history, and only `reflect` declares the block.
    const reactions = await readReactions(paths, message.channelId);

    // **Anything that arrived while this session queued is history, not queue.**
    //
    // `onMessage` only pushes to the inbox; `appendMessage` runs here. So a
    // sibling instance's reply is not in the store until *its* handle() runs,
    // and a session that waited its turn would otherwise re-answer a question
    // somebody already answered — the exact failure the interject delay was
    // built to avoid, made far likelier by a wait measured in minutes.
    //
    // They genuinely were said before this session began, so they belong in
    // `recent_messages`; the rule that history never contains the message being
    // reacted to still holds, because that one is excluded.
    const arrivedWhileQueued = channel.inbox.filter((m) => m.id !== message.id);
    const history = [
      ...stored,
      ...arrivedWhileQueued.map((m) => ({
        id: m.id,
        identityId: m.identityId,
        author: m.authorName,
        text: m.text,
        at: m.receivedAt,
        fromAgent: false,
      })),
    ];
    const seenBeforeStart = new Set(arrivedWhileQueued.map((m) => m.id));

    await appendMessage(paths, message.channelId, {
      id: message.id,
      identityId: message.identityId,
      author: message.authorName,
      text: message.text,
      at: message.receivedAt,
      fromAgent: false,
    });

    const onProgress = (note: string) => adapter.status?.(message.channelId, note);

    // Sent the moment `respond` seals, so the person is not waiting on
    // `summarize`, `review`, and `impression` — which are retrospection and
    // cost ten to twenty seconds they gain nothing from.
    const onReply = async (text: string): Promise<void> => {
      await appendMessage(paths, message.channelId, {
        id: `${message.id}-reply`,
        identityId: "agent",
        author: "agent",
        text,
        at: new Date().toISOString(),
        fromAgent: true,
      });
      await adapter.send(message.channelId, text);
    };

    channel.lastIdentity = identity;

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(message),
      identity,
      history,
      reactions,
      onProgress,
      onReply,
      onAcknowledge: async (messageId, emoji) => {
        if (!adapter.react) return;
        await adapter.react(message.channelId, messageId, emoji);
        log.log(`acknowledged with :${emoji}: in ${message.channelId}`);
      },
      queuedMs,
      // The session cannot see its own queue; the daemon owns it. This is what
      // triggers the supervisor, and it is empty unless someone spoke while a
      // step was running — anything that arrived while this session was merely
      // *queued* is already in `history` above, and the supervisor exists to
      // judge mid-session arrivals rather than to re-judge the past.
      pending: () => channelOf(message.channelId).inbox.filter((m) => !seenBeforeStart.has(m.id)),
    });
    adapter.status?.(message.channelId, `session ${result.session.id}`);

    // Arrivals the session took into account are dropped from the inbox rather
    // than drained into sessions of their own. Without this, a follow-up sent
    // while a session was working produced a second session for the same
    // exchange — the supervisor folded the message into the running session
    // *and* a fresh session answered it independently.
    const absorbed = new Set(result.consumed ?? []);
    if (absorbed.size > 0) {
      channel.inbox = channel.inbox.filter((m) => !absorbed.has(m.id));
      log.log(
        `session ${result.session.id} absorbed ${absorbed.size} message(s); ` +
          `not starting separate sessions for them`,
      );
    }
    for (const { step, verdict } of result.supervisorVerdicts ?? []) {
      log.warn(`supervisor ${verdict} during ${step}`);
    }
    if (result.budgetStop) {
      log.warn(`session ${result.session.id} cut short: ${result.budgetStop}`);
    }

    if (result.reply === undefined) {
      adapter.status?.(
        message.channelId,
        `no reply (${result.reaction?.verdict}) — ${result.reaction?.reason ?? "reaction did not ask for one"}`,
      );
    }

    // Carry on with the plan, if there is one and nothing is waiting. Runs
    // inside this channel's drain, so it is serialised with everything else and
    // an arriving message simply gets there first.
    await carryOn(message.channelId, identity, {
      plan: result.plan,
      replied: result.reply !== undefined,
    });
  }

  /**
   * Works an unfinished plan after a reply, one iteration at a time.
   *
   * Every gate is countable — a reply went out, a plan is running with items
   * left, nothing is queued, the last iteration closed something, the cap is not
   * reached. None of it is asked of a model, which is what keeps a background
   * loop from talking itself into running forever.
   */
  async function carryOn(
    channelId: string,
    identity: Identity,
    state: { plan: Plan | undefined; replied: boolean },
  ): Promise<void> {
    let plan = state.plan;
    let delta: ProgressDelta | undefined;

    for (let iteration = 1; ; iteration++) {
      const reason = shouldContinue({
        config,
        plan,
        replied: state.replied,
        pending: channelOf(channelId).inbox.length,
        nextIteration: iteration,
        delta,
      });
      if (!reason) return;

      // A turn per iteration, not one for the whole loop: a continuation is up
      // to `max_iterations` full sessions, and holding the turn across all of
      // them would starve every other instance for as long as the plan lasts.
      const result = await withTurn(
        async (queuedMs) => {
          const history = await readRecent(paths, channelId, HISTORY_LIMIT);
          return runSession({
            config,
            paths,
            trigger: continuationTrigger(channelId, iteration, reason),
            identity,
            history,
            queuedMs,
            onProgress: (note) => adapter.status?.(channelId, note),
            // The plan step reports through this when it closes the plan.
            onReply: async (text) => {
              await appendMessage(paths, channelId, {
                id: `${channelId}-report-${iteration}-${Date.now()}`,
                identityId: "agent",
                author: "agent",
                text,
                at: new Date().toISOString(),
                fromAgent: true,
              });
              await adapter.send(channelId, text);
            },
          });
        },
        { size: config.session.turn.size },
      );

      delta = result.progress;
      plan = result.plan;
      log.log(
        `continuation ${iteration} in ${channelId}: ` +
          `${delta?.closed ?? 0} item(s) closed${delta?.finished ? ", plan closed" : ""}`,
      );
    }
  }

  /**
   * A session with nothing to reply to, run when a channel has gone quiet.
   *
   * Nobody is waiting on it, so a failure is logged rather than announced: an
   * error message in the channel would be the agent breaking a silence to report
   * on work it started by itself.
   */
  async function maintain(
    channelId: string,
    identity: Identity,
    work: { steps: string[]; reason: string },
  ): Promise<void> {
    // Nobody is waiting on it, but it must not run beside a real session — the
    // whole point is that only one thing touches the weights at a time.
    const result = await withTurn(
      async (queuedMs) => {
        const history = await readRecent(paths, channelId, HISTORY_LIMIT);
        return runSession({
          config,
          paths,
          trigger: maintenanceTrigger(channelId, work.reason, work.steps),
          identity,
          history,
          queuedMs,
          onProgress: (note) => adapter.status?.(channelId, note),
        });
      },
      { size: config.session.turn.size },
    );
    log.log(
      `maintenance session ${result.session.id} in ${channelId} ` +
        `(${work.steps.join(", ")}): ${work.reason}`,
    );
  }

  /** Serial within a channel; concurrent calls join that channel's drain. */
  function drain(channelId: string): Promise<void> {
    const channel = channelOf(channelId);
    channel.draining ??= (async () => {
      try {
        while (channel.inbox.length > 0) {
          const message = channel.inbox.shift() as InboundMessage;
          try {
            // Hold back on a message nobody addressed, so a sibling instance or
            // a person has room to answer first. History is read after the
            // wait, so `react` sees any answer that arrived and declines on its
            // own — no coordination, and no need to know who else is an agent.
            const wait = interjectDelay(config.session.participation, {
              mentioned: detectMention(message.text, config.agent) !== undefined,
              queued: channel.inbox.length,
            });
            if (wait > 0) await new Promise((done) => setTimeout(done, wait));

            await handle(message);
          } catch (cause) {
            // One failed session must not take the daemon down with it, nor
            // stall the other channels — and now, nor the other instances.
            const detail = cause instanceof Error ? cause.message : String(cause);
            log.error(`session failed in ${channelId}: ${detail}`);
            await adapter.send(channelId, `(session failed: ${detail})`);
          }
        }
      } finally {
        channel.draining = undefined;
        channel.lastActivity = Date.now();
      }
    })();
    return channel.draining;
  }

  /**
   * Idle sweep. Runs maintenance in channels that have gone quiet and have work
   * waiting, one channel at a time and never alongside a live session.
   *
   * Joining the channel's own drain is what keeps that true: per-channel history
   * and the identity record assume a single writer, and an idle run writing the
   * identity summary while a session read it would be exactly the race the
   * per-channel actor exists to prevent.
   */
  function sweep(): void {
    const { enabled, idle_ms } = config.session.maintenance;
    if (!enabled) return;

    for (const [channelId, channel] of channels) {
      if (channel.draining || channel.inbox.length > 0) continue;
      if (Date.now() - channel.lastActivity < idle_ms) continue;

      const identity = channel.lastIdentity;
      if (!identity) continue;

      channel.draining = (async () => {
        try {
          const work = await pendingMaintenance(paths, config, identity);
          // Most sweeps find nothing, which is the intended behaviour: the
          // session is the expensive part and it only runs when there is work.
          if (work) await maintain(channelId, identity, work);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          log.error(`maintenance failed in ${channelId}: ${detail}`);
        } finally {
          channel.draining = undefined;
          channel.lastActivity = Date.now();
        }
      })();
    }
  }

  log.log(`working directory: ${paths.root}`);
  log.log(`ollama: ${config.ollama.host}`);

  // Checked far more often than `idle_ms`, because the sweep itself is a few
  // comparisons — the cost is in the session it may start, and that is gated on
  // there being work. `unref` so a pending timer never holds the process open.
  const sweepTimer = config.session.maintenance.enabled
    ? setInterval(sweep, Math.min(60_000, config.session.maintenance.idle_ms)).unref()
    : undefined;
  if (sweepTimer) {
    log.log(
      `maintenance sessions on: after ${config.session.maintenance.idle_ms}ms idle ` +
        `per channel, running ${config.session.maintenance.steps.join(", ")}`,
    );
  }

  await adapter.start({
    onMessage: (message) => {
      const channel = channelOf(message.channelId);
      channel.inbox.push(message);
      channel.lastActivity = Date.now();
      void drain(message.channelId);
    },

    // Recorded, never queued. A reaction is a signal about how an answer landed,
    // not a request — running a session for a 👍 would spend a pipeline to
    // conclude that nothing was asked. `reflect` reads these at the start of the
    // next real exchange, which is the step whose whole job is that judgement.
    onReaction: (reaction) => {
      void appendReaction(paths, reaction.channelId, {
        messageId: reaction.messageId,
        emoji: reaction.emoji,
        author: reaction.authorName,
        at: reaction.at,
        removed: reaction.removed,
      }).catch((cause) => {
        log.error(`could not record a reaction: ${String(cause)}`);
      });
    },
  });

  return {
    name: ref.name,
    config,
    closed: () => adapter.closed(),

    // Finish what is already in flight before shutting down, so a piped message
    // still runs its session.
    async stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      await Promise.all([...channels.values()].map((c) => c.draining));
      await adapter.stop();
    },
  };
}
