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
  /**
   * How to mark the message while the work happens. Empty for none.
   *
   * Only used when `steps` is non-empty, which is exactly when the reply stops
   * being immediate: preparatory work on `reasoning` runs for tens of seconds
   * to minutes, and until now the person saw nothing at all in that window. A
   * person who is about to go away and think puts an emoji on the message
   * first, and that is the behaviour being copied.
   */
  reaction: string;
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
  // `reaction` decodes **last**, after the steps it describes. This step is the
  // weakest in the system — it reaches for `research` by default and two prompt
  // rewrites did not move it — so a new field goes where it cannot influence
  // the choice it is reacting to. Whether a fourth field costs anything here at
  // all is unmeasured; the eval suite that would have answered it is retired.
  return z.object({
    reason: z.string(),
    needs_fact: z.boolean(),
    needs_thought: z.boolean(),
    steps: selectable.length > 0 ? z.array(chosen) : z.array(chosen).max(0),
    reaction: z.string(),
  }) as z.ZodType<Schedule>;
}

export const schedule: ModelStep<Schedule> = {
  kind: "model",
  name: "schedule",
  defaultRole: "fast",
  // Both the literal message and the restatement: the gap between them is the
  // signal, and a step given only the polished version cannot see that anything
  // was inferred.
  voice: "observer",
  contextBlocks: ["incoming_message"],
  appendix: ["request", "self_summary", "current_plan", "reflection", "user_summary"],
  outputFile: "schedule.md",
  buildSchema,

  /** Answering directly is the safe default: it is what an empty schedule means. */
  fallback: (config) => ({
    reason: "Schedule could not be parsed; answering directly.",
    needs_fact: false,
    needs_thought: false,
    steps: [],
    // Unused — no steps means no waiting — but the configured fallback keeps
    // the field honest rather than empty-by-accident.
    reaction: config.session.working_emoji,
  }),

  variables: (config) => ({
    selectable_steps: config.session.selectable_steps.join(", ") || "(none available)",
    working_emoji: config.session.working_emoji,
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
