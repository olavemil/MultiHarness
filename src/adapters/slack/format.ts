/**
 * Slack wire-format decoding. Pure, so it is testable without a socket.
 *
 * This is transport decoding rather than pipeline logic: the harness should see
 * readable text and stable ids, not Slack's encoding.
 */

const USER_MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const LINK = /<(https?:\/\/[^|>]+)(?:\|([^>]*))?>/g;
const CHANNEL_REF = /<#([A-Z0-9]+)(?:\|([^>]*))?>/g;

export interface SlackMessage {
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

/**
 * Rewrites `<@U123>` into the display name the harness knows, so mention
 * matching and the transcript both read as plain text. An unresolved id keeps a
 * readable placeholder rather than leaking raw markup into a prompt.
 */
export function decodeText(
  text: string,
  resolveUser: (id: string) => string | undefined,
): string {
  return text
    .replace(USER_MENTION, (_m, id: string) => `@${resolveUser(id) ?? id}`)
    .replace(CHANNEL_REF, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(LINK, (_m, url: string, label?: string) => label || url)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Whether an event should never reach the pipeline.
 *
 * Other bots are *not* filtered — the agent does not need to know whether it is
 * talking to a human. Only its own messages are, because replying to itself is
 * an unbounded loop.
 */
export function shouldIgnore(message: SlackMessage, botUserId: string): boolean {
  // Edits, deletions, joins, and channel chrome all arrive as subtypes.
  if (message.subtype !== undefined) return true;
  if (message.user === undefined || message.text === undefined) return true;
  if (message.user === botUserId) return true;
  return message.text.trim() === "";
}

export type ThreadMode = "separate" | "shared";

/**
 * Channel id for a message.
 *
 * `separate` gives each thread its own channel, so per-channel history and
 * reflection track one conversation rather than an interleaving of several —
 * which is what the harness's per-channel state assumes. The cost is that a
 * thread starts with no history and its own first-session skip of `reflect`.
 */
export function channelIdFor(message: SlackMessage, mode: ThreadMode): string {
  const channel = message.channel ?? "unknown";
  if (mode === "shared" || !message.thread_ts) return channel;
  return `${channel}:${message.thread_ts}`;
}

/** The thread to reply into, if the message was in one. */
export const threadTsFor = (message: SlackMessage): string | undefined => message.thread_ts;
