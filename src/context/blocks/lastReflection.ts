import type { ContextBlock } from "./types.ts";

/** The previous session's reflection in this channel. Empty on the first session here. */
export const lastReflection: ContextBlock = {
  name: "last_reflection",
  resolve: ({ prior }) => prior?.reflection.trim() || "(no previous session in this channel)",
};
