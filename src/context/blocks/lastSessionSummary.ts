import type { ContextBlock } from "./types.ts";

/** What the previous session in this channel did. Empty on the first session here. */
export const lastSessionSummary: ContextBlock = {
  name: "last_session_summary",
  resolve: ({ prior }) => prior?.summary.trim() || "(no previous session in this channel)",
};
