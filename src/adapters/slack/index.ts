import pkg from "@slack/bolt";
import type { Adapter } from "../types.ts";
import type { InboundMessage } from "../../core/types.ts";
import {
  channelIdFor,
  decodeText,
  shouldIgnore,
  threadTsFor,
  type SlackMessage,
  type ThreadMode,
} from "./format.ts";

const { App, LogLevel } = pkg;

/**
 * Slack transport over Socket Mode — no public URL, which suits a daemon
 * running on a laptop.
 *
 * Tokens come from the environment and never from config: `config/default.toml`
 * ships with the repo.
 */

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  threadMode?: ThreadMode;
  /**
   * The name the harness knows itself by. The bot's own user id resolves to
   * this rather than to its Slack display name, so `detectMention` keeps
   * working whatever the workspace calls it — otherwise a mismatch would make
   * the agent silently ignore everyone who addressed it.
   */
  agentName: string;
}

export function createSlackAdapter(opts: SlackAdapterOptions): Adapter {
  const threadMode = opts.threadMode ?? "separate";

  // Set MULTIHARNESS_DEBUG=1 to see every event the socket delivers. Without
  // it there is no way to tell "Slack is sending nothing" from "the adapter is
  // filtering everything", which are opposite problems with opposite fixes.
  const debug = process.env["MULTIHARNESS_DEBUG"] === "1";

  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: debug ? LogLevel.DEBUG : LogLevel.WARN,
  });

  /** Slack user id -> display name. Resolved lazily and cached. */
  const names = new Map<string, string>();
  /** Channel id used by the harness -> the thread to reply into. */
  const replyThreads = new Map<string, string>();

  let botUserId = "";
  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  async function displayName(userId: string): Promise<string> {
    const cached = names.get(userId);
    if (cached) return cached;
    try {
      const info = await app.client.users.info({ user: userId });
      const profile = info.user;
      const name =
        profile?.profile?.display_name ||
        profile?.real_name ||
        profile?.name ||
        userId;
      names.set(userId, name);
      return name;
    } catch {
      // A lookup failure must not drop the message; the id is still an identity.
      return userId;
    }
  }

  return {
    id: "slack",

    async start(onMessage) {
      const auth = await app.client.auth.test({});
      botUserId = String(auth.user_id ?? "");
      if (auth.user_id) names.set(String(auth.user_id), opts.agentName);

      // Runs before routing, so it reports events even when nothing handles
      // them — the case where the app is subscribed to the wrong thing.
      app.use(async ({ body, next }) => {
        if (debug) {
          const event = (body as { event?: { type?: string; subtype?: string; channel?: string } })
            .event;
          console.log(
            `[slack] event type=${event?.type ?? "?"} subtype=${event?.subtype ?? "-"} ` +
              `channel=${event?.channel ?? "-"}`,
          );
        }
        await next();
      });

      app.event("message", async ({ event }) => {
        const message = event as SlackMessage;
        if (shouldIgnore(message, botUserId)) {
          if (debug) {
            const why =
              message.subtype !== undefined
                ? `subtype=${message.subtype}`
                : message.user === botUserId
                  ? "own message"
                  : "no user or empty text";
            console.log(`[slack] ignored (${why})`);
          }
          return;
        }

        const userId = message.user as string;
        const [author] = await Promise.all([displayName(userId)]);

        // Resolve every mentioned id before decoding, so the transcript and
        // mention matching both see names rather than raw ids.
        const mentioned = [...(message.text ?? "").matchAll(/<@([A-Z0-9]+)/g)].map((m) => m[1]!);
        await Promise.all(mentioned.map((id) => displayName(id)));

        const channelId = channelIdFor(message, threadMode);
        const thread = threadTsFor(message);
        if (thread) replyThreads.set(channelId, thread);

        if (debug) console.log(`[slack] accepted from ${author}: ${(message.text ?? "").slice(0, 60)}`);

        onMessage({
          id: `${message.channel}-${message.ts}`,
          channelId,
          identityId: userId,
          authorName: author,
          text: decodeText(message.text as string, (id) => names.get(id)),
          receivedAt: new Date().toISOString(),
        } satisfies InboundMessage);
      });

      await app.start();
      console.log(
        `[slack] connected as ${opts.agentName} (${botUserId}) in ${auth.team ?? "?"} — ` +
          `waiting for messages in channels this bot has been invited to`,
      );
      if (!debug) console.log("[slack] set MULTIHARNESS_DEBUG=1 to log every incoming event");
    },

    async send(channelId, text) {
      // The harness channel id may carry a thread suffix; Slack needs the bare
      // channel plus a thread_ts.
      const [channel] = channelId.split(":");
      const thread = replyThreads.get(channelId);
      await app.client.chat.postMessage({
        channel: channel as string,
        text,
        ...(thread ? { thread_ts: thread } : {}),
      });
    },

    status(_channelId, headline) {
      // Deliberately local: a status line per step would be noise in a real
      // channel, and outbound sends need the supervisor's rate limiting first.
      console.log(`[slack] ${headline}`);
    },

    closed: () => closed,

    async stop() {
      await app.stop();
      markClosed();
    },
  };
}
