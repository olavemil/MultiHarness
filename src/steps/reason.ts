import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Thoughts {
  thinking: string;
  conclusion: string;
  uncertainties: string[];
}

const schema = z.object({
  thinking: z.string(),
  conclusion: z.string(),
  uncertainties: z.array(z.string()),
}) as z.ZodType<Thoughts>;

/**
 * Extended reasoning over what is already gathered. No tools: this step exists
 * to think, and a tool loop would turn it back into research.
 */
export const reason: ModelStep<Thoughts> = {
  kind: "model",
  name: "reason",
  defaultRole: "reasoning",
  contextBlocks: [
    "user_summary",
    "recent_messages",
    "incoming_message",
    "request",
    "prior_step_output",
    "reflection",
  ],
  outputFile: "thoughts.md",
  buildSchema: () => schema,
  defaultTools: [],

  fallback: () => ({
    thinking: "Reasoning produced no usable result this session.",
    conclusion: "",
    uncertainties: [],
  }),

  render: (t) => {
    const uncertainties =
      t.uncertainties.length > 0 ? t.uncertainties.map((u) => `- ${u}`).join("\n") : "_(none)_";
    return [
      "# Thoughts",
      "",
      t.thinking,
      "",
      "## Where this lands",
      "",
      t.conclusion || "_(no firm conclusion)_",
      "",
      "## Uncertainties",
      "",
      uncertainties,
    ].join("\n");
  },
};
