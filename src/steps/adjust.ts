import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";
import { schedule, type Schedule } from "./schedule.ts";

/**
 * Re-schedules the rest of a session, in light of what has already been done.
 *
 * The same decision `schedule` makes, at a later moment and with more to go on:
 * "after this round of research, is anything else needed before replying?"
 * It revises *session scheduling* only — the durable planning document is a
 * different lifetime and a different step.
 *
 * Shares `schedule`'s schema deliberately. It is the same question, so a
 * separate shape would be a synonym, and the field order that made `schedule`
 * discriminate between step kinds is worth keeping.
 */
export const adjust: ModelStep<Schedule> = {
  kind: "model",
  name: "adjust",
  defaultRole: "fast",
  // Unlike `schedule`, this one has finished work to read.
  contextBlocks: ["incoming_message", "recent_messages", "prior_step_output", "reflection"],
  outputFile: "adjust.md",
  buildSchema: (config: Config) => schedule.buildSchema(config),

  /** Empty means "nothing further" — go to the reply, which is the safe end. */
  fallback: () => ({
    reason: "Adjustment could not be parsed; proceeding to the reply.",
    needs_fact: false,
    needs_thought: false,
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
