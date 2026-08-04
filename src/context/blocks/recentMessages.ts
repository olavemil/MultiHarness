import type { ContextBlock } from "./types.ts";

/**
 * Channel history, oldest first. Truncates from the front so the most recent
 * exchange always survives.
 */
export const recentMessages: ContextBlock = {
  name: "recent_messages",
  keep: "tail",
  resolve: ({ history }) =>
    history.length === 0
      ? "(no earlier messages in this channel)"
      : history.map((m) => `${m.author}: ${m.text}`).join("\n"),
};
