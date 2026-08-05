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
 * Extended reasoning over what is already gathered.
 *
 * **The line against `research` is which tools, not whether.** harness.md has
 * this step "expected to make use of tools to note ideas, perhaps review outside
 * data, but primarily to think about the question at hand", and an earlier note
 * here claiming it deliberately had none was an invention. It gets the internal
 * set — knowledge, its own files, its own past sessions — and no web access,
 * which is what keeps it thinking rather than gathering. It can write files,
 * because thinking that leaves nothing behind cannot be built on.
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
