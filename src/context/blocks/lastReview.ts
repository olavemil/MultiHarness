import type { ContextBlock } from "./types.ts";

/** The previous session's review in this channel. Absent on the first session here. */
export const lastReview: ContextBlock = {
  name: "last_review",
  heading: {
    agent: "How the last session judged itself",
    observer: "How the previous session judged itself",
  },
  resolve: ({ prior }) => prior?.review.trim() || undefined,
};
