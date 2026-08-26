import type { ContextBlock } from "./types.ts";

/**
 * The `draft` step's output, as its own block rather than one entry inside
 * `prior_step_output`.
 *
 * A draft is a written reply in the agent's own voice. Arriving under "what
 * earlier steps produced", directly beneath the sender's message and next to
 * research findings, it was the single most confusable thing in the whole
 * prompt: prose in the first person, unlabelled, adjacent to somebody else's
 * prose in the first person.
 *
 * `respond` declares it as its first appendix, so it is the last thing added and
 * the most likely to be attended to.
 */
export const draft: ContextBlock = {
  name: "draft",
  heading: {
    agent: "Your own draft of this reply, to sharpen and send",
    observer: "The draft reply produced during the session",
  },
  resolve: ({ completed }) => completed.find((s) => s.name === "draft")?.content.trim(),
};
