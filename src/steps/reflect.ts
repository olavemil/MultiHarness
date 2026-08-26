import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Reflection {
  assessment: string;
  /**
   * Whether the incoming message carries any signal about the *previous*
   * session. `no_signal` is the common case and must stay easy to choose — a
   * new question says nothing about the last answer.
   */
  signal: "satisfied" | "dissatisfied" | "no_signal";
  /**
   * What was actually being asked, when the new message shows the previous
   * session answered the wrong reading of it. Empty otherwise, which is the
   * common case.
   *
   * Sealed output is immutable, so this never rewrites the previous
   * `request.md`; it is a new artifact that this session's `restate` reads.
   */
  correction: string;
  recommendations: string[];
  /**
   * What the incoming message showed about the person, if anything. Appended to
   * their impression log. This belongs here rather than in `review`: reflect
   * reads how *they* reacted, while review judges the agent's own work.
   */
  impression: string;
}

// Reasoning before the verdict it justifies. `correction` decodes after
// `signal` so the model has already committed to whether the message reacts to
// the last answer at all — a correction under `no_signal` is a contradiction it
// can see rather than one it has to be told about afterwards.
const schema = z.object({
  assessment: z.string(),
  signal: z.enum(["satisfied", "dissatisfied", "no_signal"]),
  correction: z.string(),
  recommendations: z.array(z.string()),
  impression: z.string(),
}) as z.ZodType<Reflection>;

/**
 * Opens a session by interpreting how the *previous* one landed, and writing
 * course-correction for this one.
 *
 * Runs only from the second session onward in a channel — there is nothing to
 * reflect on before that, which is why it is queued conditionally rather than
 * being part of the standing pipeline.
 */
export const reflect: ModelStep<Reflection> = {
  kind: "model",
  name: "reflect",
  defaultRole: "digest",
  voice: "observer",
  // **Nothing is mandatory.** `reflect` used to require the incoming message,
  // which was true of every session that ran it — until a reaction became able
  // to trigger one on its own. A reaction with nobody speaking afterwards is
  // exactly the case where the signal would otherwise never be read, and it is
  // the most direct evidence this step ever gets.
  contextBlocks: [],
  appendix: [
    "maintenance_batch",
    "incoming_message",
    "reactions",
    "last_contribution",
    "prior_request",
    "last_review",
    "last_debrief",
    "last_reflection",
    "last_session_summary",
    "recent_messages",
  ],
  outputFile: "reflection.md",
  buildSchema: () => schema,

  /**
   * Claiming no signal is the safe default: a fabricated critique would be
   * acted on by the very next step in this session.
   */
  fallback: () => ({
    assessment: "Reflection could not be parsed; treating the previous session as unjudged.",
    signal: "no_signal",
    correction: "",
    recommendations: [],
    impression: "",
  }),

  render: (r) => {
    const recommendations =
      r.recommendations.length > 0
        ? r.recommendations.map((line) => `- ${line}`).join("\n")
        : "_(none — carry on as before)_";

    return [
      "# Reflection",
      "",
      `**Signal from the last exchange:** ${r.signal.replace("_", " ")}`,
      "",
      r.assessment,
      "",
      "## What was actually being asked",
      "",
      r.correction.trim() || "_(the previous reading was not challenged)_",
      "",
      "## Do this session",
      "",
      recommendations,
      "",
      "## Impression of them",
      "",
      r.impression.trim() || "_(nothing new)_",
    ].join("\n");
  },
};
