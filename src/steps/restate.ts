import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface RestatedRequest {
  reasoning: string;
  /** Whether the conversation genuinely settles what is being asked. */
  resolved: boolean;
  unresolved: string[];
  request: string;
}

/**
 * Boils the conversation down to a self-contained statement of what is being
 * asked, sealed as `request.md` and read downstream through the `request` block.
 *
 * The gap it fills: several steps receive `incoming_message` as their whole
 * statement of the task, and a message like "could you draft a plan for this?"
 * hands them a pronoun with no referent. `recent_messages` is present but it is
 * a transcript, not a brief — each step has to infer the task from it, and each
 * one infers separately and differently.
 *
 * A step rather than a session-level call like `reply_target`, despite being the
 * same shape: its output is consumed by later steps, so it wants sealing, budget
 * accounting, per-step config, and — above all — the generic eval runner. A
 * bespoke path here would be the fifth instance of eval/live drift.
 *
 * **Additive, never replacing.** `incoming_message` stays available everywhere.
 * A bad restatement that silently replaced the words would poison every step
 * downstream with nothing to check it against, which is why `respond` and
 * `review` are given both.
 */
// Field order is load-bearing, as everywhere else here — and this one was
// measured. With `request` decoded first, `resolved` came back `true` on every
// run of both ambiguous cases (0/3, 0/3): the model wrote a fluent restatement
// and was then asked to judge the paragraph it had just written, which is the
// self-assessment failure this project has hit twice before. Given two candidate
// referents it merged both into one request rather than reporting either.
//
// Deciding settledness *before* any restatement exists asks about the
// transcript instead, and putting `unresolved` ahead of `request` means the open
// points are written down before the paragraph that would otherwise absorb them.
const schema = z.object({
  reasoning: z.string(),
  resolved: z.boolean(),
  unresolved: z.array(z.string()),
  request: z.string(),
}) as z.ZodType<RestatedRequest>;

export const restate: ModelStep<RestatedRequest> = {
  kind: "model",
  name: "restate",
  // `fast` first, then measure. Synthesising a task from several speakers is
  // more than the classification work `fast` has been reliable at, so this is
  // one of the likelier places for `reasoning` to earn its cost.
  defaultRole: "fast",
  // Kept deliberately short. This runs on phi4 at 8k, and the measured lesson
  // across `react`, `schedule`, and the gatekeeper is that fewer, tighter inputs
  // classify better. `prior_request` and `request_correction` earn their place
  // by carrying what the transcript cannot: what this was taken to mean last
  // time, and whether that turned out to be wrong.
  voice: "observer",
  contextBlocks: ["incoming_message", "recent_messages"],
  appendix: ["request_correction", "prior_request"],
  outputFile: "request.md",
  buildSchema: () => schema,

  /**
   * Degrades to the behaviour that preceded this step: an empty request means
   * downstream steps fall back to `incoming_message`, which is what they used
   * before. `resolved` stays `true` deliberately — claiming ambiguity with no
   * unresolved points to name would push `respond` into asking a clarifying
   * question about nothing.
   */
  fallback: () => ({
    reasoning: "The request could not be restated; the message stands on its own words.",
    resolved: true,
    unresolved: [],
    request: "",
  }),

  render: (r) => {
    const unresolved =
      r.unresolved.length > 0 ? r.unresolved.map((u) => `- ${u}`).join("\n") : "_(none)_";
    return [
      "# Request, restated",
      "",
      r.request.trim() || "_(the message was not restated; read it as written)_",
      "",
      `**Settled by the conversation:** ${r.resolved ? "yes" : "no"}`,
      "",
      "## Open points",
      "",
      unresolved,
      "",
      "---",
      "",
      `_Reading:_ ${r.reasoning}`,
    ].join("\n");
  },
};
