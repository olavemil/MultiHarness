import pkg from "@slack/bolt";
import type { Adapter } from "../types.ts";
import type { InboundMessage } from "../../core/types.ts";
import { createLogger, type Logger } from "../../instance/log.ts";
import { normaliseEmoji } from "../../core/emoji.ts";
import { resolveReactionName } from "./reactionResolver.ts";
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
  /** Slack channel id -> what the people in it call it. */
  const channelNames = new Map<string, string>();

  /** Cached known reaction names from Slack. */
  let reactionsCache: { names: string[]; fetchedAt: number } | undefined;

  let botUserId = "";
  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  /**
   * `#deploys` rather than `C07ABCXYZ`, cached like a user name.
   *
   * Only the step deciding *where* to speak unprompted needs this; nothing on
   * the reply path does, since a reply goes back where it came from. Needs
   * `channels:read` (and `groups:read` for private channels) — a failure falls
   * back to the id, which is legible if ugly and never fatal.
   */
  async function channelDisplayName(channelId: string): Promise<string | undefined> {
    const cached = channelNames.get(channelId);
    if (cached) return cached;
    try {
      const info = await app.client.conversations.info({ channel: channelId });
      const name = info.channel?.name;
      if (!name) return undefined;
      const pretty = `#${name}`;
      channelNames.set(channelId, pretty);
      return pretty;
    } catch {
      return undefined;
    }
  }

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

  /** Pulls reaction names out of a Slack payload without depending on one shape. */
  function collectReactionNames(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) collectReactionNames(item, out, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const reactions = record["reactions"];
    if (Array.isArray(reactions)) {
      for (const entry of reactions) {
        if (!entry || typeof entry !== "object") continue;
        const name = (entry as Record<string, unknown>)["name"];
        if (typeof name === "string") out.add(name);
      }
    }

    for (const nested of Object.values(record)) {
      collectReactionNames(nested, out, depth + 1);
    }
  }

  async function listKnownReactions(): Promise<string[]> {
    const now = Date.now();
    // Fresh enough: avoid one API sweep per acknowledgement.
    if (reactionsCache && now - reactionsCache.fetchedAt < 5 * 60_000) {
      return reactionsCache.names;
    }

    const names = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 25; page++) {
      const response = await app.client.reactions.list({
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      collectReactionNames((response as { items?: unknown[] }).items, names);

      const next =
        (response as { response_metadata?: { next_cursor?: string } }).response_metadata
          ?.next_cursor;
      const trimmed = next?.trim();
      if (!trimmed) break;
      cursor = trimmed;
    }

    // Complements `reactions.list`: all defined emoji names, including custom.
    try {
      const emoji = await app.client.emoji.list({});
      const declared = (emoji as { emoji?: Record<string, string> }).emoji;
      for (const name of Object.keys(declared ?? {})) names.add(name);
    } catch {
      // Optional scope; absence degrades to what `reactions.list` saw.
    }

    const known = [...names];
    reactionsCache = { names: known, fetchedAt: now };
    return known;
  }

  async function resolveReaction(emoji: string) {
    const normalised = normaliseEmoji(emoji);
    if (!normalised) return { kind: "invalid", emoji } as const;

    try {
      const known = await listKnownReactions();
      return resolveReactionName(normalised, known);
    } catch (cause) {
      log.warn(`could not list reactions for validation: ${String(cause)}`);
      return { kind: "unverified", emoji: normalised } as const;
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
        const channelName = await channelDisplayName(message.channel as string);
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
          ...(channelName ? { channelName } : {}),
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
      const resolved = await resolveReaction(emoji);
      const chosen =
        resolved.kind === "exact" || resolved.kind === "fuzzy"
          ? resolved.emoji
          : resolved.kind === "ambiguous"
            ? resolved.candidates[0] ?? emoji
            : resolved.emoji;
      const ts = messageId.slice(messageId.indexOf("-") + 1);
      const target = messageId.slice(0, messageId.indexOf("-"));
      try {
        await app.client.reactions.add({ channel: target || channelId, timestamp: ts, name: chosen });
      } catch (cause) {
        log.warn(`could not add :${chosen}: — ${String(cause)}`);
      }
    },

    async resolveReaction(emoji) {
      return resolveReaction(emoji);
    },

    /**
     * Opens a DM with one user and writes to it.
     *
     * `conversations.open` is idempotent and returns the same private channel
     * every time, so nothing has to be cached. Needs `im:write`; without it the
     * call throws and the caller logs it rather than falling back to anywhere
     * public, which would be the worst possible way to fail at a private
     * message.
     */
    async dm(identityId, text) {
      const opened = await app.client.conversations.open({ users: identityId });
      const channel = opened.channel?.id;
      if (!channel) throw new Error(`could not open a DM with ${identityId}`);
      await app.client.chat.postMessage({ channel, text });
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
