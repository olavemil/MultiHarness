import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Draft {
  notes: string;
  draft: string;
}

const schema = z.object({
  notes: z.string(),
  draft: z.string().min(1),
}) as z.ZodType<Draft>;

/**
 * A first pass at the reply, for `respond` to sharpen.
 *
 * Worth running when the answer is long or delicate enough that composing and
 * judging it at once goes badly. `notes` comes first so the model works out its
 * approach before writing to it.
 */
export const draft: ModelStep<Draft> = {
  kind: "model",
  name: "draft",
  defaultRole: "reasoning",
  contextBlocks: [
    "user_summary",
    "recent_messages",
    "incoming_message",
    "request",
    "prior_step_output",
    "reflection",
  ],
  outputFile: "draft.md",
  buildSchema: () => schema,
  defaultTools: [],

  fallback: () => ({
    notes: "Draft could not be parsed.",
    draft: "",
  }),

  render: (d) => ["# Draft", "", d.draft, "", "---", "", `_Approach:_ ${d.notes}`].join("\n"),
};
