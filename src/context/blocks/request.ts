import type { ContextBlock } from "./types.ts";

/**
 * This session's `restate` output: the incoming message written as a
 * self-contained statement of what is being asked.
 *
 * Absent whenever `restate` did not run — the first message in a channel has no
 * history to boil down, and the declining path never reaches it.
 *
 * The heading says "as this session restated it" in both voices on purpose.
 * It is the agent's own artifact about what somebody else asked, and a step that
 * reads it as the sender's own words will answer wording nobody wrote.
 */
export const request: ContextBlock = {
  name: "request",
  heading: {
    agent: "What is being asked, as this session restated it",
    observer: "The request, as the session restated it",
  },
  resolve: ({ completed }) => completed.find((s) => s.name === "restate")?.content.trim(),
};
