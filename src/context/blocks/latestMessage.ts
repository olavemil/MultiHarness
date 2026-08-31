import type { ContextBlock } from "./types.ts";

/**
 * The last thing said in the conversation being written into, or the last thing
 * this person said anywhere.
 *
 * **What lets an unprompted message branch from something rather than land out
 * of nowhere.** `recent_messages` already ends with it, but buried at the foot
 * of a transcript it is one line among twelve; singled out, it is the thing the
 * agent can pick up — "you were asking about X" reads as continuing a
 * conversation, and the same message without it reads as an interruption.
 *
 * For a person the harness looks across every channel, because the last thing
 * they said is worth having wherever they said it — and a DM the agent is
 * opening has no history of its own to draw on.
 */
export const latestMessage: ContextBlock = {
  name: "latest_message",
  keep: "tail",
  heading: {
    agent: "The last thing said there",
    observer: "The last message in that conversation",
  },
  resolve: ({ latestMessage: latest }) => {
    if (!latest) return undefined;
    const where = latest.where ? ` (in ${latest.where})` : "";
    return `${latest.author}${where}: ${latest.text}`;
  },
};
