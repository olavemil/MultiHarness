import type { ContextBlock } from "./types.ts";

/**
 * The synthesised summary of the person being spoken to.
 *
 * Absent until `impression` has written one, which is the state a new channel
 * starts in. It used to render the display name over "(nothing known about them
 * yet)" — a heading, an alias list, and an admission of ignorance, all costing
 * budget to tell a step nothing.
 */
export const userSummary: ContextBlock = {
  name: "user_summary",
  heading: {
    agent: "What you know about ${sender}",
    observer: "What is on file about ${sender}",
  },
  resolve: ({ identity }) => identity.summary.trim() || undefined,
};
