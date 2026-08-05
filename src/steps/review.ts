import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Review {
  quality: number;
  assessment: string;
  recommendations: string[];
}

// Reasoning before the field it justifies. Constrained decoding emits keys in
// schema order, so `quality` first would have the model pick a number and then
// write an assessment to fit it. Same rule as `react`.
const schema = z.object({
  assessment: z.string(),
  quality: z.number().int().min(1).max(5),
  recommendations: z.array(z.string()),
}) as z.ZodType<Review>;

export const review: ModelStep<Review> = {
  kind: "model",
  name: "review",
  defaultRole: "digest",
  // `session_summary` alone is a timing table — judging the quality of a reply
  // requires seeing the reply, which is what `prior_step_output` carries.
  // The restatement joins them because comparing it against the literal message
  // is the only way interpretation drift becomes visible after the fact.
  contextBlocks: ["incoming_message", "request", "prior_step_output", "session_summary"],
  outputFile: "review.md",
  buildSchema: () => schema,

  /**
   * A failed review must not invent a verdict. Neutral quality and no
   * recommendations, because a fabricated critique would be acted on by the
   * next session.
   */
  fallback: () => ({
    quality: 3,
    assessment: "Review could not be parsed; no judgement was recorded for this session.",
    recommendations: [],
  }),

  render: (r) => {
    const recommendations =
      r.recommendations.length > 0
        ? r.recommendations.map((line) => `- ${line}`).join("\n")
        : "_(none)_";

    return [
      "# Review",
      "",
      `**Quality:** ${r.quality}/5`,
      "",
      r.assessment,
      "",
      "## Recommendations",
      "",
      recommendations,
    ].join("\n");
  },
};
