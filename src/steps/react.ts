import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

/**
 * What the arriving message wants, if anything.
 *
 * A boolean here answered "was the agent addressed?", which is a pure
 * agent's question — under it, somebody sharing a thought correctly produces
 * silence, and that is a real failure seen live. Four outcomes let the step say
 * "this wants acknowledging" or "this is not mine" without collapsing both into
 * "no", and give the harness something to do other than nothing.
 */
export type ReactionVerdict = "reply" | "acknowledge" | "for_someone_else" | "tangent";

export interface Reaction {
  reason: string;
  verdict: ReactionVerdict;
  /**
   * How much the agent has to add, 0 to 1.
   *
   * Feeds weighted participation, which previously took a bare boolean and
   * scaled the odds ×1.5 or ×0.5. A continuous value is strictly better input to
   * the same formula, and it is where "seldom engages with my replies" becomes a
   * number rather than prose.
   */
  interest: number;
}

/** Whether the verdict calls for a written answer. The only reader of it. */
export const wantsReply = (reaction: Reaction): boolean => reaction.verdict === "reply";

/**
 * One question only: what does this message want? How a session is structured is
 * `schedule`'s job, and separating them lets a named message skip this entirely.
 */
function buildSchema(_config: Config): z.ZodType<Reaction> {
  // Reasoning first, then the verdict it justifies, then how much the agent
  // actually has to add — which is a different question from whether a reply is
  // wanted, and worth asking after it rather than instead of it.
  return z.object({
    reason: z.string(),
    verdict: z.enum(["reply", "acknowledge", "for_someone_else", "tangent"]),
    interest: z.number().min(0).max(1),
  }) as z.ZodType<Reaction>;
}

export const react: ModelStep<Reaction> = {
  kind: "model",
  name: "react",
  defaultRole: "fast",
  contextBlocks: ["user_summary", "recent_messages", "incoming_message", "reflection"],
  situational: true,
  outputFile: "reaction.md",
  buildSchema,

  /**
   * Replying is the safe default. A parse failure is a harness problem, and
   * going silent because of one would look to the person waiting exactly like
   * being ignored.
   */
  fallback: () => ({
    reason: "Reaction could not be parsed; defaulting to a direct reply.",
    verdict: "reply",
    interest: 0.5,
  }),

  render: (reaction) =>
    [
      "# Reaction",
      "",
      `**Verdict:** ${reaction.verdict.replace(/_/g, " ")}`,
      `**Respond:** ${wantsReply(reaction) ? "yes" : "no"}`,
      `**Interest:** ${reaction.interest.toFixed(2)}`,
      "",
      `**Reason:** ${reaction.reason}`,
    ].join("\n"),
};
