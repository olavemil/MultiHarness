import type { ContextBlock } from "./types.ts";

/**
 * Channel history, oldest first. Truncates from the front so the most recent
 * exchange always survives.
 *
 * Absent in a channel with no history — the first message in a channel is
 * already self-contained, and a heading over "(no earlier messages)" only
 * invites a step to reason about the emptiness.
 */
export const recentMessages: ContextBlock = {
  name: "recent_messages",
  keep: "tail",
  heading: {
    agent: "The conversation so far",
    observer: "Transcript",
  },
  resolve: ({ history }) =>
    history.length === 0 ? undefined : history.map((m) => `${m.author}: ${m.text}`).join("\n"),
};
