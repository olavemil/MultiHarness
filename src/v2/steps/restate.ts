import { z } from "zod";
import { document } from "../compose/section.ts";
import { presentAgentAndChannel } from "../compose/fragments.ts";
import { ModelRole } from "../values.ts";
import { output, transcript, type StepInput } from "./input.ts";
import type { Step } from "./types.ts";

export interface Request {
  /** Decoded first: settledness is judged before any restatement exists. */
  resolved: boolean;
  request: string;
  openPoints: string[];
}

/**
 * Restates the incoming message as a self-contained statement of the task.
 *
 * **Runs before `reflect` here, which is the order reversed from v1.** In v1
 * `reflect` ran first and had to work out unaided what the message referred to
 * — the job this step exists to do. Reflection then reported misreadings of
 * exactly the kind that ordering produces.
 */
export const restate: Step<StepInput, Request> = {
  name: "restate",
  role: ModelRole.fast,
  outputFile: "request.md",

  // Read top to bottom: this *is* the prompt. Nothing is appended elsewhere.
  context: (i) => [
    "# Task",
    "State what is being asked, as a self-contained request.",

    // An analyst outside the conversation, not the agent. Chosen here, not
    // derived from a `voice` field somewhere else.
    presentAgentAndChannel.onlooker(i.principal),

    i.message && ["## The message", "```", i.message, "```"],

    transcript(i, 12) && [
      "## Recent messages",
      "Oldest first.",
      "",
      transcript(i, 12)!,
    ],

    // Headings demoted, so a sealed document nests without breaking structure.
    // Absent entirely when there is no correction, which is the common case.
    document("## A correction from the last exchange", i.prior?.correction),
    document("## What was asked last time", i.prior?.request),

    "## Output",
    "Return JSON only:",
    [
      "- `resolved` — whether it is clear what is being asked.",
      "- `request` — the request, stated so it stands alone.",
      "- `openPoints` — what would have to be asked to settle it. Empty when resolved.",
    ],
  ],

  schema: z.object({
    resolved: z.boolean(),
    request: z.string(),
    openPoints: z.array(z.string()),
  }) as z.ZodType<Request>,

  fallback: () => ({
    resolved: false,
    request: "",
    openPoints: [],
  }),

  render: (r) =>
    [
      "# Request",
      "",
      r.request.trim() || "_(could not be restated)_",
      "",
      "## Open points",
      "",
      r.openPoints.length > 0
        ? r.openPoints.map((p) => `- ${p}`).join("\n")
        : "_(none — the request is settled)_",
    ].join("\n"),

  // Declared here rather than as a branch in the runner.
  apply(r, fx) {
    fx.note("resolved", String(r.resolved));
  },
};

/** Sealed restatement from earlier this session, for steps that follow. */
export const restatement = (i: StepInput): string | undefined => output(i, restate.name);
