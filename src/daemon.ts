import path from "node:path";
import { createCliAdapter } from "./adapters/cli.ts";
import type { Config } from "./config/schema.ts";
import type { Adapter } from "./adapters/types.ts";
import { loadConfig } from "./config/load.ts";
import type { Identity, InboundMessage } from "./core/types.ts";
import { maintenanceTrigger, messageTrigger } from "./core/trigger.ts";
import { pendingMaintenance } from "./session/maintenance.ts";
import { runSession } from "./session/run.ts";
import { appendMessage, readRecent } from "./store/channelStore.ts";
import { loadIdentity } from "./store/identityStore.ts";
import { ensurePaths, resolvePaths } from "./store/paths.ts";
import { instanceHome } from "./config/load.ts";

/**
 * Reads `<instance>/.env` when present, so secrets sit beside the instance
 * rather than having to be exported by whatever launches the daemon. Anything
 * already in the environment wins.
 */
function loadInstanceEnv(): void {
  const file = path.join(instanceHome(), ".env");
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent is normal: the CLI adapter needs no secrets at all.
  }
}

const HISTORY_LIMIT = 40;

/**
 * Slack when it is configured, otherwise the CLI. Tokens come from the
 * environment; a missing one is a startup error rather than a silent fallback
 * to stdin, which would look like the adapter working.
 */
async function selectAdapter(config: Config): Promise<Adapter> {
  if (!config.slack.enabled) return createCliAdapter();

  const botToken = process.env["SLACK_BOT_TOKEN"];
  const appToken = process.env["SLACK_APP_TOKEN"];
  if (!botToken || !appToken) {
    throw new Error(
      "[slack] enabled but SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not both set. " +
        "The bot token starts xoxb-, the app-level token for Socket Mode starts xapp-.",
    );
  }

  // Imported lazily so the CLI path does not pay for Bolt's dependency tree.
  const { createSlackAdapter } = await import("./adapters/slack/index.ts");
  return createSlackAdapter({
    botToken,
    appToken,
    threadMode: config.slack.thread_mode,
    agentName: config.agent.name,
  });
}

/**
 * The harness runs headless. Adapters attach and detach; nothing about the
 * agent's lifetime is tied to any one of them being connected.
 *
 * Sessions run one at a time, drained from an inbox. The per-channel actor and
 * the parallel supervisor arrive with the long-running steps that make them
 * worth having.
 */
async function main(): Promise<void> {
  loadInstanceEnv();
  const config = await loadConfig();
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const adapter: Adapter = await selectAdapter(config);

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
    // History is read before the triggering message is appended, so a step's
    // `recent_messages` block never contains the message it is reacting to.
    const history = await readRecent(paths, message.channelId, HISTORY_LIMIT);
    const identity = await loadIdentity(paths, message.identityId, message.authorName);

    await appendMessage(paths, message.channelId, {
      id: message.id,
      identityId: message.identityId,
      author: message.authorName,
      text: message.text,
      at: message.receivedAt,
      fromAgent: false,
    });

    adapter.status?.(message.channelId, "thinking");

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

    const channel = channelOf(message.channelId);
    channel.lastIdentity = identity;

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(message),
      identity,
      history,
      onReply,
      // The session cannot see its own queue; the daemon owns it. This is what
      // triggers the supervisor, and it is empty unless someone spoke while a
      // step was running.
      pending: () => [...channelOf(message.channelId).inbox],
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
      console.log(
        `[daemon] session ${result.session.id} absorbed ${absorbed.size} message(s); ` +
          `not starting separate sessions for them`,
      );
    }
    for (const { text } of result.deferred ?? []) {
      // Left in the inbox on purpose: deferral means it is owed a session.
      console.log(`[daemon] deferred to its own session: ${text.slice(0, 60)}`);
    }
    for (const { step, verdict } of result.supervisorVerdicts ?? []) {
      console.warn(`[daemon] supervisor ${verdict} during ${step}`);
    }
    if (result.budgetStop) {
      console.warn(`[daemon] session ${result.session.id} cut short: ${result.budgetStop}`);
    }

    if (result.reply === undefined) {
      adapter.status?.(
        message.channelId,
        `no reply — ${result.reaction?.reason ?? "reaction did not ask for one"}`,
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
    const history = await readRecent(paths, channelId, HISTORY_LIMIT);
    const result = await runSession({
      config,
      paths,
      trigger: maintenanceTrigger(channelId, work.reason, work.steps),
      identity,
      history,
    });
    console.log(
      `[daemon] maintenance session ${result.session.id} in ${channelId} ` +
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
            await handle(message);
          } catch (cause) {
            // One failed session must not take the daemon down with it, nor
            // stall the other channels.
            const detail = cause instanceof Error ? cause.message : String(cause);
            console.error(`[daemon] session failed in ${channelId}: ${detail}`);
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
          console.error(`[daemon] maintenance failed in ${channelId}: ${detail}`);
        } finally {
          channel.draining = undefined;
          channel.lastActivity = Date.now();
        }
      })();
    }
  }

  console.log(`[daemon] working directory: ${paths.root}`);
  console.log(`[daemon] ollama: ${config.ollama.host}`);

  // Checked far more often than `idle_ms`, because the sweep itself is a few
  // comparisons — the cost is in the session it may start, and that is gated on
  // there being work. `unref` so a pending timer never holds the process open.
  const sweepTimer = config.session.maintenance.enabled
    ? setInterval(sweep, Math.min(60_000, config.session.maintenance.idle_ms)).unref()
    : undefined;
  if (sweepTimer) {
    console.log(
      `[daemon] maintenance sessions on: after ${config.session.maintenance.idle_ms}ms idle ` +
        `per channel, running ${config.session.maintenance.steps.join(", ")}`,
    );
  }

  await adapter.start((message) => {
    const channel = channelOf(message.channelId);
    channel.inbox.push(message);
    channel.lastActivity = Date.now();
    void drain(message.channelId);
  });

  // Input ended (Ctrl-D, or a closed pipe). Finish what is already in flight
  // before shutting down, so a piped message still runs its session.
  await adapter.closed();
  if (sweepTimer) clearInterval(sweepTimer);
  await Promise.all([...channels.values()].map((c) => c.draining));
  await adapter.stop();
}

await main();
