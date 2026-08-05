import type { ContextBlock } from "./types.ts";

/**
 * Reactions people put on the agent's own recent messages.
 *
 * The most direct evidence `reflect` ever gets about how an answer landed.
 * Everything else it reads is prose it has to interpret — a follow-up question,
 * a change of subject, a bare "thanks" — whereas somebody deliberately marking a
 * reply is an unambiguous signal, and a cheap one for them to send.
 *
 * It is still only a signal, not a verdict: a 👍 says the reply was received, not
 * that it was right, and a single emoji carries far less than a sentence would.
 */
export const reactions: ContextBlock = {
  name: "reactions",
  keep: "tail",
  resolve: ({ reactions: seen }) => {
    if (!seen || seen.length === 0) return "(nobody has reacted to anything the agent wrote)";
    return seen.map((r) => `- :${r.emoji}: from ${r.author}`).join("\n");
  },
};
