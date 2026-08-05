import pkg from "@slack/bolt";
import type { Adapter } from "../types.ts";
import type { InboundMessage } from "../../core/types.ts";
import { createLogger, type Logger } from "../../instance/log.ts";
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
  /**
   * Where this adapter's lines go. Several agents may be connected from one
   * process, to different workspaces, so an unattributed `[slack]` line is
   * unattributable — and "which of them is not seeing events?" is the question
   * this logging exists to answer.
   */
  log?: Logger;
}

export function createSlackAdapter(opts: SlackAdapterOptions): Adapter {
  const threadMode = opts.threadMode ?? "separate";
  const log = opts.log ?? createLogger("slack");

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

    async start({ onMessage, onReaction }) {
      const auth = await app.client.auth.test({});
      botUserId = String(auth.user_id ?? "");
      if (auth.user_id) names.set(String(auth.user_id), opts.agentName);

      // Runs before routing, so it reports events even when nothing handles
      // them — the case where the app is subscribed to the wrong thing.
      app.use(async ({ body, next }) => {
        if (debug) {
          const event = (body as { event?: { type?: string; subtype?: string; channel?: string } })
            .event;
          log.log(
            `event type=${event?.type ?? "?"} subtype=${event?.subtype ?? "-"} ` +
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
            log.log(`ignored (${why})`);
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

        if (debug) log.log(`accepted from ${author}: ${(message.text ?? "").slice(0, 60)}`);

        onMessage({
          id: `${message.channel}-${message.ts}`,
          channelId,
          identityId: userId,
          authorName: author,
          text: decodeText(message.text as string, (id) => names.get(id)),
          receivedAt: new Date().toISOString(),
        } satisfies InboundMessage);
      });

      // Reactions to the agent's own messages only. A reaction between two other
      // people is a conversation the agent is not part of, and treating it as a
      // signal about its own answers would be reading somebody else's post.
      //
      // Needs the `reactions:read` scope and the `reaction_added` /
      // `reaction_removed` event subscriptions; without them this handler simply
      // never fires, which MULTIHARNESS_DEBUG=1 makes visible.
      for (const kind of ["reaction_added", "reaction_removed"] as const) {
        app.event(kind, async ({ event }) => {
          const reaction = event as unknown as {
            user?: string;
            reaction?: string;
            item?: { channel?: string; ts?: string };
            item_user?: string;
          };
          if (!onReaction) return;
          if (reaction.item_user !== botUserId) {
            if (debug) log.log(`${kind} ignored (not on our message)`);
            return;
          }
          const channel = reaction.item?.channel;
          const ts = reaction.item?.ts;
          if (!channel || !ts || !reaction.user) return;

          const author = await displayName(reaction.user);
          if (debug) log.log(`${kind} :${reaction.reaction}: from ${author}`);

          onReaction({
            channelId: channel,
            messageId: `${channel}-${ts}`,
            emoji: String(reaction.reaction ?? ""),
            identityId: reaction.user,
            authorName: author,
            at: new Date().toISOString(),
            removed: kind === "reaction_removed",
          });
        });
      }

      await app.start();
      log.log(
        `connected as ${opts.agentName} (${botUserId}) in ${auth.team ?? "?"} — ` +
          `waiting for messages in channels this bot has been invited to`,
      );
      if (!debug) log.log("set MULTIHARNESS_DEBUG=1 to log every incoming event");
    },

    // Needs the `reactions:write` scope. A failure is logged and swallowed: a
    // reaction is a courtesy, and a session must not die because one could not
    // be added — `already_reacted` alone would otherwise be fatal.
    async react(channelId, messageId, emoji) {
      const ts = messageId.slice(messageId.indexOf("-") + 1);
      const target = messageId.slice(0, messageId.indexOf("-"));
      try {
        await app.client.reactions.add({ channel: target || channelId, timestamp: ts, name: emoji });
      } catch (cause) {
        log.warn(`could not add :${emoji}: — ${String(cause)}`);
      }
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
      log.log(headline);
    },

    closed: () => closed,

    async stop() {
      await app.stop();
      markClosed();
    },
  };
}
