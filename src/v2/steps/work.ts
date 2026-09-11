import { z } from "zod";
import { document } from "../compose/section.ts";
import { presentAgentAndChannel } from "../compose/fragments.ts";
import { ModelRole } from "../values.ts";
import { describeWork } from "../work.ts";
import { type StepInput } from "./input.ts";
import type { Step } from "./types.ts";

export interface WorkDone {
  /**
   * Decoded before the account of what was done, so the model commits to
   * whether the item is finished before it writes a paragraph that will read
   * like completion whatever happened.
   *
   * The one judgement the harness cannot make. Attempts are countable and
   * capped in `work.ts`; whether the task is *done* is not, and v1 avoided
   * asking it by making progress a fact about two plan revisions. That worked
   * because a plan has enumerated items. A free-text task has none, so this
   * asks — and the attempt cap is what makes a wrong answer survivable.
   */
  finished: boolean;
  findings: string;
  /** Anything the work turned up that is worth keeping. Usually empty. */
  learned: string;
}

/**
 * Does one item of background work.
 *
 * **Nobody is waiting.** That is the whole difference from a reply step, and
 * the prompt says so: there is no length to match, no register to read, and the
 * output is for the agent itself rather than for a person.
 */
export const doWork: Step<StepInput, WorkDone> = {
  name: "work",
  role: ModelRole.reasoning,
  outputFile: "work_done.md",

  context: (i) => [
    "# Task",
    "Work on this. Nobody is waiting for it and nobody will read it but you.",

    presentAgentAndChannel.agent(i.principal),

    i.currentWork && [
      `## What you decided to do (${i.currentWork.kind})`,
      "",
      i.currentWork.task,
      ...(i.currentWork.attempts > 0
        ? [
            "",
            `You have been at this ${i.currentWork.attempts} time(s) already. ` +
              `If it is not going anywhere, say so and finish it rather than going round again.`,
          ]
        : []),
    ],

    document("## Your background thinking", i.thinking),

    i.plan && ["## The plan this belongs to", `**Goal:** ${i.plan.goal}`],

    "## Output",
    "Return JSON only:",
    [
      "- `finished` — whether this item is done with. Say yes when you have got as far as you usefully can.",
      "- `findings` — what you worked out. Write it for yourself, later.",
      "- `learned` — one durable fact worth keeping, if there is one. Usually empty.",
    ],
  ],

  schema: z.object({
    finished: z.boolean(),
    findings: z.string(),
    learned: z.string(),
  }) as z.ZodType<WorkDone>,

  /**
   * Unfinished on a parse failure, so the item stays on the list and the
   * attempt cap decides its fate. Claiming completion would silently discard
   * work the agent asked for.
   */
  fallback: () => ({
    finished: false,
    findings: "Could not be parsed.",
    learned: "",
  }),

  render: (w) =>
    [
      "# Work",
      "",
      `**Finished:** ${w.finished ? "yes" : "no"}`,
      "",
      w.findings.trim() || "_(nothing recorded)_",
      ...(w.learned.trim() ? ["", "## Worth keeping", "", w.learned.trim()] : []),
    ].join("\n"),

  apply(w, fx) {
    fx.note("finished", String(w.finished));
    // Through the gatekeeper, which may refuse it. A step never writes to the
    // store on its own authority, in v2 as in v1.
    if (w.learned.trim()) fx.knowledge("", w.learned.trim());
  },
};

/** What a background session runs: one item, then nothing else. */
export const backgroundSteps = [doWork] as const;

export { describeWork };
