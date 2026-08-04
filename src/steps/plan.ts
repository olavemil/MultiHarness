import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

export interface Plan {
  reason: string;
  steps: { step: string; topic: string }[];
}

/**
 * Structures a session once the decision to reply has been made.
 *
 * Split out of `react` deliberately. Fusing "should this be answered?" with
 * "how should answering be organised?" made one call answer two unrelated
 * questions, and forced `react` to run even when being named had already
 * settled the first — a named message now skips straight to here.
 */
function buildSchema(config: Config): z.ZodType<Plan> {
  const selectable = config.session.selectable_steps;
  const chosen =
    selectable.length > 0
      ? z.object({ step: z.enum(selectable as [string, ...string[]]), topic: z.string() })
      : z.object({ step: z.string(), topic: z.string() });

  return z.object({
    reason: z.string(),
    steps: selectable.length > 0 ? z.array(chosen) : z.array(chosen).max(0),
  }) as z.ZodType<Plan>;
}

export const plan: ModelStep<Plan> = {
  kind: "model",
  name: "plan",
  defaultRole: "fast",
  contextBlocks: ["user_summary", "recent_messages", "incoming_message", "reflection"],
  outputFile: "plan_0.md",
  buildSchema,

  /** Answering directly is the safe default: it is what an empty plan means. */
  fallback: () => ({
    reason: "Plan could not be parsed; answering directly.",
    steps: [],
  }),

  variables: (config) => ({
    selectable_steps: config.session.selectable_steps.join(", ") || "(none available)",
  }),

  render: (p) => {
    const steps =
      p.steps.length > 0
        ? p.steps.map((s) => `- \`${s.step}\` — ${s.topic}`).join("\n")
        : "_(none — answer directly)_";
    return ["# Plan", "", `**Reasoning:** ${p.reason}`, "", "## Steps", "", steps].join("\n");
  },
};
