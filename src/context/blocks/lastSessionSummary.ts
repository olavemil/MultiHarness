import type { ContextBlock } from "./types.ts";

/** What the previous session in this channel did. Absent on the first session here. */
export const lastSessionSummary: ContextBlock = {
  name: "last_session_summary",
  heading: {
    agent: "What the last session did",
    observer: "What the previous session did",
  },
  resolve: ({ prior }) => prior?.summary.trim() || undefined,
};
