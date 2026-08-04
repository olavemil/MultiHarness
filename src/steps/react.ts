import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

export interface Reaction {
  respond: boolean;
  reason: string;
  steps: { step: string; topic: string }[];
}

/**
 * Compiles the configured step vocabulary into the schema, so constrained
 * decoding physically cannot emit a step that is not configured.
 */
function buildSchema(config: Config): z.ZodType<Reaction> {
  const selectable = config.session.selectable_steps;

  const chosen =
    selectable.length > 0
      ? z.object({
          step: z.enum(selectable as [string, ...string[]]),
          topic: z.string(),
        })
      : z.object({ step: z.string(), topic: z.string() });

  // Field order is load-bearing. Constrained decoding emits keys in schema
  // order, so `respond` first means the model commits to a boolean and then
  // rationalises it — qwen3:4b was observed writing "the message is aimed at
  // me" as the justification for `respond: false`. Reasoning first makes the
  // decision follow the argument rather than precede it.
  return z.object({
    reason: z.string(),
    respond: z.boolean(),
    steps: selectable.length > 0 ? z.array(chosen) : z.array(chosen).max(0),
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
   * Responding is the safe default. A parse failure is a harness problem, and
   * going silent because of one would look to the person waiting exactly like
   * being ignored.
   */
  fallback: () => ({
    respond: true,
    reason: "Reaction could not be parsed; defaulting to a direct reply.",
    steps: [],
  }),

  variables: (config) => ({
    selectable_steps: config.session.selectable_steps.join(", ") || "(none available)",
  }),

  render: (reaction) => {
    const steps =
      reaction.steps.length > 0
        ? reaction.steps.map((s) => `- \`${s.step}\` — ${s.topic}`).join("\n")
        : "_(none)_";

    return [
      "# Reaction",
      "",
      `**Respond:** ${reaction.respond ? "yes" : "no"}`,
      "",
      `**Reason:** ${reaction.reason}`,
      "",
      "## Steps",
      "",
      steps,
    ].join("\n");
  },
};
