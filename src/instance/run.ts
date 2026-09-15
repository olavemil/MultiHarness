import { createCliAdapter } from "../adapters/cli.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config/schema.ts";
import { loadConfig } from "../config/load.ts";
import type { Identity, InboundMessage } from "../core/types.ts";
import { continuationTrigger, maintenanceTrigger, messageTrigger } from "../core/trigger.ts";
import { detectMention } from "../core/mentions.ts";
import { interjectDelay } from "../core/participation.ts";
import { pendingMaintenance, type MaintenanceWork } from "../session/maintenance.ts";
import { runV2Background } from "../v2/background.ts";
import { loadWorkList, saveWorkList } from "../v2/workStore.ts";
import { addWork, completeWork, nextWork, recordAttempt } from "../v2/work.ts";
import { eligibleTargets, type InitiativeTarget } from "../core/initiative.ts";
import { rememberChannel, surveyChannels } from "../store/channelRegistry.ts";
import { lastPerTarget, loadInitiative, recordInitiative } from "../store/initiativeStore.ts";
import { listIdentities } from "../store/identityStore.ts";
import { openKnowledgeDb } from "../knowledge/db.ts";
import { impressionCount } from "../knowledge/impressions.ts";
import { shouldContinue, type ProgressDelta } from "../session/continuation.ts";
import type { Plan } from "../store/planStore.ts";
import { runSession } from "../session/run.ts";
import { turnQueueDepth, withTurn } from "../session/turn.ts";
import { appendMessage, readRecent } from "../store/channelStore.ts";
import {
  appendReaction,
  readNewReactions,
  writeReactionWatermark,
  type StoredReaction,
} from "../store/reactionStore.ts";
import { loadIdentity, saveIdentity } from "../store/identityStore.ts";
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
  let maintenanceBatchRunning = false;

  const channelOf = (id: string): Channel => {
    let existing = channels.get(id);
    if (!existing) {
      existing = { inbox: [], lastActivity: Date.now() };
      channels.set(id, existing);
    }
    return existing;
  };

  /**
   * Rebuild in-memory channel state from persisted history.
   *
   * Maintenance should not depend on seeing a *new* message after startup: the
   * channel registry and history already contain enough to know which channels
   * exist, how long they have been quiet, and who was last speaking there.
   */
  async function hydrateChannelsFromStore(): Promise<void> {
    const now = Date.now();
    const known = await surveyChannels(paths, config.agent.name, HISTORY_LIMIT);

    for (const entry of known) {
      const channel = channelOf(entry.id);

      // Infinity means "no known last activity"; treat it as very old rather
      // than NaN/-Infinity so the idle gate can still reason about it.
      channel.lastActivity = Number.isFinite(entry.silentMs)
        ? Math.max(0, now - entry.silentMs)
        : 0;

      // `pendingMaintenance` needs an identity for impression synthesis.
      // Recover it from the latest non-agent message in persisted history.
      if (!channel.lastIdentity) {
        const history = await readRecent(paths, entry.id, HISTORY_LIMIT);
        const lastHuman = [...history].reverse().find((m) => !m.fromAgent);
        if (lastHuman) {
          channel.lastIdentity = await loadIdentity(
            paths,
            lastHuman.identityId,
            lastHuman.author,
          );
        }
      }
    }

    if (known.length > 0) {
      log.log(`hydrated ${known.length} known channel(s) from stored history`);
    }
  }

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
    // Recorded on every message so a rename follows the workspace, and so an
    // idle agent can survey rooms it has not heard from since the last restart.
    await rememberChannel(paths, message.channelId, message.channelName, message.receivedAt);

    const stored = await readRecent(paths, message.channelId, HISTORY_LIMIT);
    const identity = await loadIdentity(paths, message.identityId, message.authorName);
    // Recorded here so an idle agent can tell a colleague from somebody who
    // stopped talking three months ago. Nothing on the reply path reads it.
    await saveIdentity(paths, { ...identity, lastSeenAt: message.receivedAt });
    // Read alongside history, and only `reflect` declares the block.
    // Only what has not been reflected on yet. Every standing reaction used to
    // be handed over at every session, so a 👍 from three exchanges ago arrived
    // looking exactly as fresh as one from a minute ago — and this step's whole
    // job is judging what the *latest* signal says.
    const reactions = await readNewReactions(paths, message.channelId);

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
        author: config.agent.name,
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
      loadInitiativeTargets: computeInitiativeTargets,
      resolveReaction: async (emoji) => {
        if (!adapter.resolveReaction) return { kind: "unverified", emoji };
        return adapter.resolveReaction(emoji);
      },
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

    // The ordinary path: `reflect` read these at the start of this session, so
    // they are spent. Without this they stay "new" for ever and every later
    // sweep sees work to do that has already been done.
    await markReactionsSeen(message.channelId, result.completed, reactions);
    if (result.budgetStop) {
      log.warn(`session ${result.session.id} cut short: ${result.budgetStop}`);
    }

    if (result.reply === undefined) {
      adapter.status?.(
        message.channelId,
        `no reply (${result.decision?.verdict ?? "no decision"}) — ${result.decision?.reason ?? "nothing asked for one"}`,
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
                author: config.agent.name,
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
  /**
   * Sends something the agent decided to say into a channel nobody prompted.
   *
   * Delivered here rather than from the session because the channel is not the
   * session's own — and because the cooldown that stops this becoming a nuisance
   * is instance-wide, so it belongs where every channel can see it.
   *
   * The message is appended to that channel's history like any other thing the
   * agent said, which matters: the next session there reads it as the agent's
   * last contribution, so `reflect` can judge how it landed.
   */
  async function deliverInitiatives(
    initiatives: NonNullable<Awaited<ReturnType<typeof runSession>>["initiatives"]>  | undefined,
  ): Promise<void> {
    for (const it of initiatives ?? []) {
      try {
        if (it.kind === "dm") {
          if (!adapter.dm) {
            // Skipped rather than posted anywhere else. Falling back to a
            // channel would turn a private message into a public one, which is
            // the worst available way to fail at this.
            log.warn(`cannot message ${it.name} directly on ${adapter.id}; skipped`);
            continue;
          }
          await adapter.dm(it.id, it.message);
        } else {
          await adapter.send(it.id, it.message);
          // Appended to that channel's history like anything else the agent
          // said, so the next session there reads it as the last contribution
          // and `reflect` can judge how it landed.
          await appendMessage(paths, it.id, {
            id: `${it.id}-initiative-${Date.now()}`,
            identityId: "agent",
            author: config.agent.name,
            text: it.message,
            at: new Date().toISOString(),
            fromAgent: true,
          });
          channelOf(it.id).lastActivity = Date.now();
        }

        // Stamped only after it actually went out — before delivery it would
        // silence the agent for days on the strength of a send that failed.
        await recordInitiative(paths, it.ref);
        log.log(`wrote to ${it.name} unprompted: ${it.message.slice(0, 60)}`);
      } catch (cause) {
        log.error(`could not write to ${it.name}: ${String(cause)}`);
      }
    }
  }

  /**
   * Cross-channel candidate targets for `initiate`, behind countable gates.
   *
   * Shared by maintenance and message sessions so both use exactly the same
   * eligibility/cooldown logic.
   */
  async function computeInitiativeTargets(): Promise<InitiativeTarget[]> {
    const record = await loadInitiative(paths);
    const identities = await listIdentities(paths);

    // Only people the agent has actually formed a view of. An impression means
    // several exchanges' worth of noticing, which is the difference between
    // writing to somebody you know and writing to a name in a log.
    const db = openKnowledgeDb(paths.knowledge);
    let counts: Map<string, number>;
    try {
      counts = new Map(identities.map((p) => [p.id, impressionCount(db, p.id)]));
    } finally {
      db.close();
    }

    const gate = eligibleTargets({
      config,
      channels: await surveyChannels(paths, config.agent.name),
      identities,
      impressionCounts: counts,
      lastInitiatedAt: record.at,
      lastPerTarget: lastPerTarget(record),
    });

    if (gate.blocked) log.log(`not starting anything: ${gate.blocked}`);
    return gate.eligible;
  }

  async function maintain(
    channelId: string,
    identity: Identity,
    work: MaintenanceWork,
    maintenanceBatch?: readonly { channelId: string; steps: readonly string[]; reason: string }[],
  ): Promise<void> {
    let seen: readonly StoredReaction[] = [];

    // **The survey spans channels, so the daemon builds it, not the session.**
    // Only channels that already passed the countable gates are offered, so the
    // step is asked "is any of this worth saying?" and never "is it a reasonable
    // hour?" — the bounds are not something a model gets to reason about.
    let targets: InitiativeTarget[] = [];
    if (work.steps.includes("initiate")) {
      targets = await computeInitiativeTargets();
      if (targets.length === 0) {
        work = { ...work, steps: work.steps.filter((name) => name !== "initiate") };
        if (work.steps.length === 0) return;
      }
    }

    // Nobody is waiting on it, but it must not run beside a real session — the
    // whole point is that only one thing touches the weights at a time.
    const result = await withTurn(
      async (queuedMs) => {
        const history = await readRecent(paths, channelId, HISTORY_LIMIT);
        // The reason this session may be running at all: a reaction arrived and
        // nobody spoke afterwards, so nothing else would ever read it.
        seen = await readNewReactions(paths, channelId);
        return runSession({
          config,
          paths,
          trigger: maintenanceTrigger(channelId, work.reason, work.steps, work.curiosity),
          identity,
          history,
          reactions: seen,
          maintenanceBatch,
          queuedMs,
          initiativeTargets: targets,
          onProgress: (note) => adapter.status?.(channelId, note),
        });
      },
      { size: config.session.turn.size },
    );
    await markReactionsSeen(channelId, result.completed, seen);
    await deliverInitiatives(result.initiatives);
    log.log(
      `maintenance session ${result.session.id} in ${channelId} ` +
        `(${work.steps.join(", ")}): ${work.reason}`,
    );
  }

  /**
   * Runs one channel's maintenance work under that channel's drain marker.
   *
   * The marker keeps per-channel serialisation intact: a real session for this
   * channel will wait until maintenance is done, rather than running beside it.
   */
  function drainMaintenance(
    channelId: string,
    identity: Identity,
    work: MaintenanceWork,
    maintenanceBatch?: readonly { channelId: string; steps: readonly string[]; reason: string }[],
  ): Promise<void> {
    const channel = channelOf(channelId);
    const running = (async () => {
      try {
        await maintain(channelId, identity, work, maintenanceBatch);
      } finally {
        channel.draining = undefined;
        channel.lastActivity = Date.now();
      }
    })();

    channel.draining = running;
    return running;
  }

  /**
   * Moves the watermark to the newest reaction the session was actually given.
   *
   * Two ways to get this wrong and both lose a signal silently:
   *
   * - **Moving it when `reflect` did not run.** Nothing looked, so nothing was
   *   seen; advancing anyway discards the reaction unread, which is the failure
   *   the watermark exists to prevent with the sign flipped.
   * - **Stamping the wall clock instead.** A reaction arriving *while* the
   *   session ran is older than "now" and would be filtered out for ever after,
   *   having never been in front of anything. Stamping what was handed over
   *   leaves it strictly newer, so the next sweep still finds it.
   */
  async function markReactionsSeen(
    channelId: string,
    completed: readonly { name: string }[],
    seen: readonly { at: string }[],
  ): Promise<void> {
    if (seen.length === 0) return;
    if (!completed.some((step) => step.name === config.session.reflect_step)) return;

    const newest = seen.reduce((latest, r) => (r.at > latest ? r.at : latest), seen[0]!.at);
    await writeReactionWatermark(paths, channelId, newest).catch((cause) => {
      log.error(`could not record which reactions were seen in ${channelId}: ${String(cause)}`);
    });
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
    * Idle sweep. Runs one global maintenance batch once every tracked channel is
    * quiet, and each channel's maintenance work runs under that channel's drain.
   *
   * Joining the channel's own drain is what keeps that true: per-channel history
   * and the identity record assume a single writer, and an idle run writing the
   * identity summary while a session read it would be exactly the race the
   * per-channel actor exists to prevent.
   */
  /**
   * One iteration of v2 background work, when this instance is on the flag.
   *
   * **The sweep's own structure is shared and the work discovery is not**, which
   * is what lets the two coexist. "Is everything quiet, and is there anything to
   * do?" is the same question for both; what differs is who answers the second
   * half — `pendingMaintenance` counts thresholds, and the v2 list holds what
   * the agent said it wanted. So this sits beside the v1 branch rather than
   * replacing it, and an instance runs one or the other.
   *
   * Runs under the originating channel's drain, for the same reason v1
   * maintenance does: per-channel history has one writer.
   */
  async function sweepV2(): Promise<void> {
    const list = await loadWorkList(paths);
    const policy = { maxAttempts: config.session.background.max_attempts };

    // Messages always win. Checked here as well as in `nextWork`, because
    // between the two the sweep may have been waiting on the turn.
    const busy = [...channels.values()].some((c) => c.draining || c.inbox.length > 0);
    const item = nextWork(list, policy, busy);
    if (!item) return;

    const channelId = item.origin.channelId || [...channels.keys()][0];
    if (!channelId) return;
    const channel = channelOf(channelId);
    const identity = channel.lastIdentity;
    if (!identity) return;

    // Recorded *before* the work runs, not after. A session that dies with the
    // daemon would otherwise leave the attempt uncounted, and an item that can
    // kill the process would be retried for ever — the one shape that turns
    // "background work never finishing" from acceptable into a loop.
    await saveWorkList(paths, recordAttempt(list, item, policy));

    const running = (async () => {
      try {
        const result = await withTurn(
          async () =>
            runV2Background({
              config,
              paths,
              channelId,
              identity,
              item,
              onProgress: (note) => adapter.status?.(channelId, note),
            }),
          { size: config.session.turn.size },
        );

        // Reloaded rather than reusing `list`: a message session may have
        // proposed work while this one ran, and writing a stale list back would
        // drop it.
        const after = await loadWorkList(paths);
        const settled = result.finished
          ? completeWork(after, after.items.find((i) => i.task === item.task) ?? item)
          : after;
        await saveWorkList(paths, addWork(settled, result.proposed));

        log.log(
          `background session ${result.session.id} (${item.kind}): ` +
            `${result.finished ? "finished" : "continuing"}`,
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        log.error(`background work failed: ${detail}`);
      } finally {
        channel.draining = undefined;
        channel.lastActivity = Date.now();
      }
    })();

    channel.draining = running;
    await running;
  }

  function sweep(): void {
    const { enabled, idle_ms } = config.session.maintenance;

    // The v2 branch. Gated on the same global idle check below, and on its own
    // config, so an instance on neither does nothing and an instance on both
    // would run v2 only — they are alternatives, not layers.
    if (config.v2 && config.session.background.enabled) {
      if (maintenanceBatchRunning) return;
      const now = Date.now();
      const allIdle = [...channels.values()].every(
        (c) => !c.draining && c.inbox.length === 0 && now - c.lastActivity >= idle_ms,
      );
      if (!allIdle) return;

      maintenanceBatchRunning = true;
      void sweepV2()
        .catch((cause: unknown) => {
          const detail = cause instanceof Error ? cause.message : String(cause);
          log.error(`background sweep failed: ${detail}`);
        })
        .finally(() => {
          maintenanceBatchRunning = false;
        });
      return;
    }

    if (!enabled) return;
    if (maintenanceBatchRunning) return;

    const now = Date.now();
    // Global idle gate: maintenance runs only once the whole instance is quiet.
    // A single active channel keeps all channels on the reply path.
    const allIdle = [...channels.values()].every(
      (channel) =>
        !channel.draining &&
        channel.inbox.length === 0 &&
        now - channel.lastActivity >= idle_ms,
    );
    if (!allIdle) return;

    maintenanceBatchRunning = true;
    void (async () => {
      const batch: { channelId: string; identity: Identity; work: MaintenanceWork }[] = [];
      for (const [channelId, channel] of channels) {
        if (channel.draining || channel.inbox.length > 0) continue;
        if (now - channel.lastActivity < idle_ms) continue;
        const identity = channel.lastIdentity;
        if (!identity) continue;

        try {
          const work = await pendingMaintenance(paths, config, identity, channelId);
          // Most sweeps find nothing, which is the intended behaviour: the
          // session is the expensive part and it only runs when there is work.
          if (work) batch.push({ channelId, identity, work });
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          log.error(`maintenance planning failed in ${channelId}: ${detail}`);
        }
      }

      if (batch.length === 0) return;

      const maintenanceBatch = batch.map(({ channelId, work }) => ({
        channelId,
        steps: [...work.steps],
        reason: work.reason,
      }));

      for (const { channelId, identity, work } of batch) {
        try {
          await drainMaintenance(channelId, identity, work, maintenanceBatch);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          log.error(`maintenance failed in ${channelId}: ${detail}`);
        }
      }
    })().finally(() => {
      maintenanceBatchRunning = false;
    });
  }

  log.log(`working directory: ${paths.root}`);
  log.log(`ollama: ${config.ollama.host}`);
  if (config.omlx) log.log(`omlx: ${config.omlx.host}`);

  // Before idle scheduling starts. Without this, maintenance only sees channels
  // that have received messages since this daemon started.
  await hydrateChannelsFromStore();

  // Checked far more often than `idle_ms`, because the sweep itself is a few
  // comparisons — the cost is in the session it may start, and that is gated on
  // there being work. `unref` so a pending timer never holds the process open.
  const sweepTimer = config.session.maintenance.enabled
    ? setInterval(sweep, Math.min(60_000, config.session.maintenance.idle_ms)).unref()
    : undefined;
  if (sweepTimer) {
    log.log(
      `maintenance sessions on: after ${config.session.maintenance.idle_ms}ms idle ` +
        `across all channels, running ${config.session.maintenance.steps.join(", ")}`,
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
