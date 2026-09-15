import { z } from "zod";
import { document } from "../compose/section.ts";
import { presentAgentAndChannel } from "../compose/fragments.ts";
import { ModelRole, WORK_KINDS } from "../values.ts";
import { describeWork } from "../work.ts";
import { output, transcript, type StepInput } from "./input.ts";
import type { Step } from "./types.ts";

export interface ScheduledWork {
  /**
   * Decoded first, so the model commits to whether anything is worth doing
   * before it starts naming things to do.
   *
   * The field-order trick this repo has measured twice: a model that writes a
   * list first will not then declare the list unnecessary. Without this the
   * step invents work every time, which is the failure that makes a background
   * loop worthless — it never idles, so nothing it does means anything.
   */
  anythingWorthDoing: boolean;
  reason: string;
  work: { kind: string; task: string }[];
}

/**
 * Closes a session by deciding what, if anything, is worth doing next.
 *
 * **This is the step v1 does not have, and its absence is why the agent never
 * initiates.** v1 discovers background work by counting: impressions past a
 * threshold, entries with three or more notes, a question that resurfaced
 * twice. Every one of those is the harness noticing a number crossed a line.
 * Nothing anywhere asks the agent what it wants to do.
 *
 * The prompt therefore has one job and it is a genuine judgement, which is
 * exactly the kind of thing worth being able to tweak — the motivation behind
 * this whole experiment.
 *
 * **It leans hard toward proposing nothing.** An agent that always finds
 * something to do has not decided anything; it has a busy-work generator. The
 * strong empty default is the same shape as `reflect`'s `no_signal` and
 * `prune`'s "close nothing", both of which needed it for the same reason.
 */
export const scheduleWork: Step<StepInput, ScheduledWork> = {
  name: "schedule_work",
  role: ModelRole.reasoning,
  outputFile: "work.md",

  context: (i) => [
    "# Task",
    "Decide whether anything is worth working on once this exchange is over.",

    // The agent deciding what it wants, so it is addressed as the agent.
    presentAgentAndChannel.agent(i.principal),

    i.message && ["## What was just said", "```", i.message, "```"],

    document("## What it was asking", output(i, "restate")),
    document("## What you concluded", output(i, "reflect")),

    i.plan && [
      "## The plan you are already running",
      `**Goal:** ${i.plan.goal}`,
      ...(i.plan.outstanding.length > 0
        ? ["", "Still outstanding:", ...i.plan.outstanding.map((o) => `- ${o}`)]
        : []),
    ],

    // What is already queued. Without it the agent proposes the same thing
    // every session and the list grows without ever being worked through.
    i.pendingWork &&
      describeWork(i.pendingWork) && [
        "## Already on your list",
        "Do not propose these again. Add something only if it is genuinely different.",
        "",
        describeWork(i.pendingWork)!,
      ],

    transcript(i, 8) && ["## Recent messages", "Oldest first.", "", transcript(i, 8)!],

    "## What counts",
    [
      "- `research` — something you would have to look up to answer properly.",
      "- `reason` — something you have the facts for but have not thought through.",
      "- `write` — something worth writing down for later, in your own files.",
      "- `contact` — something worth telling somebody, unprompted.",
    ],

    "## How to decide",
    "Most exchanges leave nothing worth doing. A question you answered is finished. " +
      "Say so and stop there — proposing work you do not actually want is worse than " +
      "proposing none, because it crowds out the times you do.",
    "Propose something when this exchange left you with a question you could not answer, " +
      "or a thread you would genuinely pursue if you had the time. You do have the time.",

    "## Output",
    "Return JSON only:",
    [
      "- `anythingWorthDoing` — whether anything is. Usually not.",
      "- `reason` — one line on why.",
      "- `work` — items, each `{kind, task}`. Empty unless the above is true.",
      "",
      `\`kind\` is one of: ${WORK_KINDS.join(", ")}.`,
    ],
  ],

  schema: z.object({
    anythingWorthDoing: z.boolean(),
    reason: z.string(),
    work: z.array(z.object({ kind: z.enum(WORK_KINDS), task: z.string() })),
  }) as z.ZodType<ScheduledWork>,

  /** Nothing proposed. A parse failure must not invent work the agent never asked for. */
  fallback: () => ({
    anythingWorthDoing: false,
    reason: "Could not be parsed; proposing nothing.",
    work: [],
  }),

  render: (s) =>
    [
      "# Work proposed",
      "",
      s.reason.trim() || "_(no reason given)_",
      "",
      ...(s.anythingWorthDoing && s.work.length > 0
        ? s.work.map((w) => `- **${w.kind}** — ${w.task}`)
        : ["_(nothing — the exchange is finished with)_"]),
    ].join("\n"),

  apply(s, fx) {
    // The gate is respected here rather than in the prompt: a model that says
    // "nothing worth doing" and then lists three things has contradicted
    // itself, and the boolean it committed to first is the answer.
    if (!s.anythingWorthDoing) return;
    for (const item of s.work) fx.work(item.kind, item.task);
  },
};
