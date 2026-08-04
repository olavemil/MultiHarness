import type { ContextBlock } from "./types.ts";

/** The previous session's review in this channel. Empty on the first session here. */
export const lastReview: ContextBlock = {
  name: "last_review",
  resolve: ({ prior }) => prior?.review.trim() || "(no previous session in this channel)",
};
