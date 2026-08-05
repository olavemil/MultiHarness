import path from "node:path";
import { createCliAdapter } from "./adapters/cli.ts";
import type { Config } from "./config/schema.ts";
import type { Adapter } from "./adapters/types.ts";
import { loadConfig } from "./config/load.ts";
import type { InboundMessage } from "./core/types.ts";
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
  const channels = new Map<string, { inbox: InboundMessage[]; draining?: Promise<void> | undefined }>();

  const channelOf = (id: string) => {
    let existing = channels.get(id);
    if (!existing) {
      existing = { inbox: [] };
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

    const result = await runSession({
      config,
      paths,
      message,
      identity,
      history,
      onReply,
      // The session cannot see its own queue; the daemon owns it. This is what
      // triggers the supervisor, and it is empty unless someone spoke while a
      // step was running.
      pending: () => [...channelOf(message.channelId).inbox],
    });
    adapter.status?.(message.channelId, `session ${result.session.id}`);
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
      }
    })();
    return channel.draining;
  }

  console.log(`[daemon] working directory: ${paths.root}`);
  console.log(`[daemon] ollama: ${config.ollama.host}`);

  await adapter.start((message) => {
    channelOf(message.channelId).inbox.push(message);
    void drain(message.channelId);
  });

  // Input ended (Ctrl-D, or a closed pipe). Finish what is already in flight
  // before shutting down, so a piped message still runs its session.
  await adapter.closed();
  await Promise.all([...channels.values()].map((c) => c.draining));
  await adapter.stop();
}

await main();
