import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

export interface Adjustment {
  reason: string;
  /** Whether the work already done is enough to reply from. */
  finished: boolean;
  steps: { step: string; topic: string }[];
}

/**
 * Re-schedules the rest of a session, in light of what has already been done.
 *
 * The same decision `schedule` makes, at a later moment and with more to go on:
 * "after this round of research, is anything else needed before replying?"
 * It revises *session scheduling* only — the durable planning document is a
 * different lifetime and a different step.
 *
 * It does **not** share `schedule`'s schema, despite asking a related question.
 * `schedule` decodes `needs_fact` and `needs_thought` first, which is right at
 * the start of a session where nothing has been done. After work has finished
 * those booleans prejudge the answer: a research step's "Still unknown" list
 * makes `needs_fact` true, which then drags `steps` along with it. Measured
 * with the shared schema, `adjust` never returned an empty list — it re-ran
 * searches that had already come up empty, and queued work even when told the
 * budget was exhausted.
 *
 * `finished` decodes first instead, so the model commits to whether anything
 * remains before naming anything to do.
 */
export const adjust: ModelStep<Adjustment> = {
  kind: "model",
  name: "adjust",
  defaultRole: "fast",
  // Unlike `schedule`, this one has finished work to read.
  contextBlocks: ["incoming_message", "recent_messages", "prior_step_output", "reflection"],
  outputFile: "adjust.md",
  buildSchema: (config: Config) => {
    const selectable = config.session.selectable_steps;
    const chosen =
      selectable.length > 0
        ? z.object({ step: z.enum(selectable as [string, ...string[]]), topic: z.string() })
        : z.object({ step: z.string(), topic: z.string() });

    return z.object({
      reason: z.string(),
      finished: z.boolean(),
      steps: selectable.length > 0 ? z.array(chosen) : z.array(chosen).max(0),
    }) as z.ZodType<Adjustment>;
  },

  /** Empty means "nothing further" — go to the reply, which is the safe end. */
  fallback: () => ({
    reason: "Adjustment could not be parsed; proceeding to the reply.",
    finished: true,
    steps: [],
  }),

  variables: (config) => ({
    selectable_steps: config.session.selectable_steps.join(", ") || "(none available)",
  }),

  render: (a) => {
    const steps =
      a.steps.length > 0
        ? a.steps.map((s) => `- \`${s.step}\` — ${s.topic}`).join("\n")
        : "_(nothing further — reply now)_";
    return ["# Adjustment", "", `**Reasoning:** ${a.reason}`, "", "## Remaining steps", "", steps].join("\n");
  },
};
