import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Debrief {
  assessment: string;
  /**
   * Anything that arrived mid-session and still has no answer. Empty when
   * everything that was said got dealt with, which is the ordinary case.
   */
  unanswered: string[];
  /** One line the next session in this channel needs. Empty unless it does. */
  carry_forward: string;
}

// Reasoning before the findings it justifies, as everywhere else here.
const schema = z.object({
  assessment: z.string(),
  unanswered: z.array(z.string()),
  carry_forward: z.string(),
}) as z.ZodType<Debrief>;

/**
 * Closes a session that was interrupted, and judges how the interruption went.
 *
 * Queued only when something arrived while the session was working — most
 * sessions never run it.
 *
 * **The supervisor has had no feedback loop.** `update` issues verdicts and
 * `adjust` applies them; nothing had ever assessed whether a verdict was right.
 * This is the first thing that looks back at one.
 *
 * The concrete failure it exists to catch is narrower and worse: the session
 * changed course because of an arrival — `adjust` or `respond_now` — and then
 * finished without ever addressing it. Those are the messages nothing else will
 * pick up, because consuming them takes them out of the inbox. An arrival the
 * session merely carried past is still queued and is not its problem.
 *
 * Distinct from `review`, which asks how well the reply served the person, and
 * from `reflect`, which opens the *next* session by reading how the last one
 * landed. Same family, three different questions — fusing any two would repeat
 * the mistake `react` and `schedule` were split to undo.
 */
export const debrief: ModelStep<Debrief> = {
  kind: "model",
  name: "debrief",
  defaultRole: "digest",
  contextBlocks: [
    "incoming_message",
    "mid_session_messages",
    "prior_step_output",
    "session_summary",
  ],
  outputFile: "debrief.md",
  buildSchema: () => schema,

  /**
   * Claims nothing on a parse failure. Inventing an unanswered question would
   * have the next session chase something nobody asked, and the sealed output is
   * read by that session directly.
   */
  fallback: () => ({
    assessment: "The debrief could not be parsed; no judgement was recorded.",
    unanswered: [],
    carry_forward: "",
  }),

  render: (d) => {
    const unanswered =
      d.unanswered.length > 0
        ? d.unanswered.map((line) => `- ${line}`).join("\n")
        : "_(nothing — everything said was dealt with)_";

    return [
      "# Debrief",
      "",
      d.assessment,
      "",
      "## Still unanswered",
      "",
      unanswered,
      "",
      "## For the next session",
      "",
      d.carry_forward.trim() || "_(nothing to carry)_",
    ].join("\n");
  },
};
