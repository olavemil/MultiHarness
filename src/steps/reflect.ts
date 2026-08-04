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
  recommendations: string[];
  /**
   * What the incoming message showed about the person, if anything. Appended to
   * their impression log. This belongs here rather than in `review`: reflect
   * reads how *they* reacted, while review judges the agent's own work.
   */
  impression: string;
}

// Reasoning before the verdict it justifies.
const schema = z.object({
  assessment: z.string(),
  signal: z.enum(["satisfied", "dissatisfied", "no_signal"]),
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
  contextBlocks: [
    "user_summary",
    "recent_messages",
    "incoming_message",
    "last_review",
    "last_session_summary",
    "last_reflection",
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
