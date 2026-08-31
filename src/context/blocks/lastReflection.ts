import type { ContextBlock } from "./types.ts";

/** The previous session's reflection in this channel. Absent on the first session here. */
export const lastReflection: ContextBlock = {
  name: "last_reflection",
  heading: {
    agent: "What you told yourself last time",
    observer: "What the previous session told itself to do",
  },
  resolve: ({ prior }) => prior?.reflection.trim() || undefined,
};
