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

  const inbox: InboundMessage[] = [];
  let draining: Promise<void> | undefined;

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

    const result = await runSession({ config, paths, message, identity, history });
    adapter.status?.(message.channelId, `session ${result.session.id}`);

    if (result.reply === undefined) {
      adapter.status?.(
        message.channelId,
        `no reply — ${result.reaction?.reason ?? "reaction did not ask for one"}`,
      );
      return;
    }

    await appendMessage(paths, message.channelId, {
      id: `${message.id}-reply`,
      identityId: "agent",
      author: "agent",
      text: result.reply,
      at: new Date().toISOString(),
      fromAgent: true,
    });
    await adapter.send(message.channelId, result.reply);
  }

  /** Sessions run one at a time; concurrent calls join the in-flight drain. */
  function drain(): Promise<void> {
    draining ??= (async () => {
      try {
        while (inbox.length > 0) {
          const message = inbox.shift() as InboundMessage;
          try {
            await handle(message);
          } catch (cause) {
            // One failed session must not take the daemon down with it.
            const detail = cause instanceof Error ? cause.message : String(cause);
            console.error(`[daemon] session failed: ${detail}`);
            await adapter.send(message.channelId, `(session failed: ${detail})`);
          }
        }
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  }

  console.log(`[daemon] working directory: ${paths.root}`);
  console.log(`[daemon] ollama: ${config.ollama.host}`);

  await adapter.start((message) => {
    inbox.push(message);
    void drain();
  });

  // Input ended (Ctrl-D, or a closed pipe). Finish what is already in flight
  // before shutting down, so a piped message still runs its session.
  await adapter.closed();
  await draining;
  await adapter.stop();
}

await main();
