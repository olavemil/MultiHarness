import type { ContextBlock } from "./types.ts";

/**
 * This session's own `reflect` output — the course-correction the agent just
 * wrote for itself, as distinct from `last_reflection`, which is the previous
 * session's.
 */
export const reflection: ContextBlock = {
  name: "reflection",
  resolve: ({ completed }) => {
    const step = completed.find((s) => s.name === "reflect");
    return step ? step.content.trim() : "(no reflection this session)";
  },
};
