import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

export interface Schedule {
  reason: string;
  /** Something checkable is missing — a fact that exists outside this conversation. */
  needs_fact: boolean;
  /** The difficulty is working something out, not looking something up. */
  needs_thought: boolean;
  steps: { step: string; topic: string }[];
}

/**
 * Chooses which steps run in *this session*, once the decision to reply has
 * been made.
 *
 * Deliberately not called `plan`: that name belongs to the durable,
 * cross-session planning document, and `plan_N.md` to its revisions. This is
 * scheduling — which steps, in what order, right now — and conflating the two
 * would collide on both the vocabulary and the filenames.
 *
 * Split out of `react` deliberately. Fusing "should this be answered?" with
 * "how should answering be organised?" made one call answer two unrelated
 * questions, and forced `react` to run even when being named had already
 * settled the first — a named message now skips straight to here.
 */
function buildSchema(config: Config): z.ZodType<Schedule> {
  const selectable = config.session.selectable_steps;
  const chosen =
    selectable.length > 0
      ? z.object({ step: z.enum(selectable as [string, ...string[]]), topic: z.string() })
      : z.object({ step: z.string(), topic: z.string() });

  // `needs_fact` and `needs_thought` decode before `steps` on purpose. Measured
  // behaviour without them: `research` was chosen for everything and `reason`
  // and `draft` effectively never, because "what kind of help is missing?" was
  // never asked — the model went straight to naming a step. Committing to the
  // kind of gap first is the same field-order lever that fixed `react`.
  return z.object({
    reason: z.string(),
    needs_fact: z.boolean(),
    needs_thought: z.boolean(),
    steps: selectable.length > 0 ? z.array(chosen) : z.array(chosen).max(0),
  }) as z.ZodType<Schedule>;
}

export const schedule: ModelStep<Schedule> = {
  kind: "model",
  name: "schedule",
  defaultRole: "fast",
  contextBlocks: ["user_summary", "recent_messages", "incoming_message", "reflection"],
  outputFile: "schedule.md",
  buildSchema,

  /** Answering directly is the safe default: it is what an empty schedule means. */
  fallback: () => ({
    reason: "Schedule could not be parsed; answering directly.",
    needs_fact: false,
    needs_thought: false,
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
    return [
      "# Schedule",
      "",
      `**Reasoning:** ${p.reason}`,
      "",
      `**Missing:** ${p.needs_fact ? "a fact" : ""}${p.needs_fact && p.needs_thought ? " and " : ""}` +
        `${p.needs_thought ? "deliberation" : ""}${!p.needs_fact && !p.needs_thought ? "nothing" : ""}`,
      "",
      "## Steps",
      "",
      steps,
    ].join("\n");
  },
};
