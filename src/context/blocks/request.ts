import type { ContextBlock } from "./types.ts";

/**
 * This session's `restate` output: the incoming message written as a
 * self-contained statement of what is being asked.
 *
 * Absent whenever `restate` did not run — the first message in a channel has no
 * history to boil down, and the declining path never reaches it. Steps that
 * declare this block must therefore read as sensibly with it empty as with it
 * filled, which is why the fallback names the message itself.
 */
export const request: ContextBlock = {
  name: "request",
  resolve: ({ completed }) => {
    const step = completed.find((s) => s.name === "restate");
    return step ? step.content.trim() : "(the message was not restated; read it as written)";
  },
};
