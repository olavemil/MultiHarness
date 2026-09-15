import { z } from "zod";
import { document } from "../compose/section.ts";
import { presentAgentAndChannel, workUnderReview } from "../compose/fragments.ts";
import { ModelRole } from "../values.ts";
import { transcript, type StepInput } from "./input.ts";
import { restatement } from "./restate.ts";
import type { Step } from "./types.ts";

export interface Reflection {
  assessment: string;
  signal: "satisfied" | "dissatisfied" | "no_signal";
  correction: string;
  recommendations: string[];
  impression: string;
}

/**
 * Judges how the previous exchange landed.
 *
 * **Runs after `restate`, which is the change this folder exists to test.**
 * It receives the restated request rather than deriving one, so it is judging
 * a settled reading instead of guessing at one. The two v1 symptoms — mistaking
 * what the message refers to, and asking whether it correctly said nothing when
 * the message plainly answers the agent — are both what "guess first, resolve
 * afterwards" produces.
 *
 * `lastContribution` is included unconditionally here, unlike v1, where it was
 * suppressed whenever the previous session carried the answer. That suppression
 * was measured — quoting the agent's own reply right before asking whether it
 * landed primed `satisfied` — but it removed the evidence in exactly the case
 * being complained about. With the reading settled upstream the priming has a
 * different shape, so this is the thing to measure first.
 */
export const reflect: Step<StepInput, Reflection> = {
  name: "reflect",
  role: ModelRole.digest,
  outputFile: "reflection.md",

  context: (i) => [
    "# Task",
    "Judge how the previous exchange landed. Most of the time it carries no verdict at all.",

    presentAgentAndChannel.onlooker(i.principal),
    workUnderReview.onlooker(),

    i.message && ["## The new message", "```", i.message, "```"],

    // The settled reading, from the step that just ran. This is what v1 had to
    // infer, and inferring it is where the reported failures came from.
    document("## What it is asking", restatement(i)),

    i.lastContribution && [
      `## What ${i.principal.agentName} last said here`,
      i.lastContribution.messagesSince === 0
        ? "This was the message immediately before the one above."
        : `${i.lastContribution.messagesSince} messages have been sent since.`,
      "",
      "```",
      i.lastContribution.text,
      "```",
    ],

    document("## The previous session's own review", i.prior?.review),

    transcript(i, 10) && ["## Recent messages", "Oldest first.", "", transcript(i, 10)!],

    "## Output",
    "Return JSON only:",
    [
      "- `assessment` — what the new message shows about the last answer, if anything.",
      "- `signal` — `satisfied`, `dissatisfied`, or `no_signal`.",
      "- `correction` — what was *actually* being asked, if the last session answered the wrong reading. Empty otherwise, which is usual.",
      "- `recommendations` — course-correction for this session. Empty is the common answer.",
      "- `impression` — what this showed about the person, if anything.",
    ],
    "A new question says nothing about the previous answer. Neither does thanks. " +
      "Claiming no signal is almost always right, and an invented critique is acted on " +
      "by the very next step.",
  ],

  // Reasoning before the verdict it justifies; `correction` after `signal`, so
  // a correction under `no_signal` is a contradiction the model can see.
  schema: z.object({
    assessment: z.string(),
    signal: z.enum(["satisfied", "dissatisfied", "no_signal"]),
    correction: z.string(),
    recommendations: z.array(z.string()),
    impression: z.string(),
  }) as z.ZodType<Reflection>,

  fallback: () => ({
    assessment: "Could not be parsed; treating the previous session as unjudged.",
    signal: "no_signal",
    correction: "",
    recommendations: [],
    impression: "",
  }),

  render: (r) =>
    [
      "# Reflection",
      "",
      `**Signal:** ${r.signal.replace("_", " ")}`,
      "",
      r.assessment,
      "",
      "## Do this session",
      "",
      r.recommendations.length > 0
        ? r.recommendations.map((l) => `- ${l}`).join("\n")
        : "_(none — carry on as before)_",
    ].join("\n"),

  /**
   * The 25 lines that sat 400 lines away in v1's runner, next to the step that
   * causes them.
   */
  apply(r, fx) {
    if (r.impression.trim()) fx.impression(r.impression);
    if (r.correction.trim()) fx.note("correction", r.correction);
  },
};
