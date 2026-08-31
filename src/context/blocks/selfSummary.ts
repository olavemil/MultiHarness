import type { ContextBlock } from "./types.ts";

/**
 * Persistent cross-channel self-summary, written by a fast neutral step.
 */
export const selfSummary: ContextBlock = {
  name: "self_summary",
  heading: {
    agent: "Your current cross-channel self summary",
    observer: "The agent's current cross-channel self summary",
  },
  resolve: ({ selfSummary }) => selfSummary?.trim() || undefined,
};
