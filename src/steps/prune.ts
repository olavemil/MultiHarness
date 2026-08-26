import { z } from "zod";
import type { ModelStep } from "./types.ts";

/**
 * Reads the open questions the agent has accumulated and says which are done
 * with.
 *
 * **This is the guard the whole mechanism rests on, and it is the half that is
 * easy to skip.** Open questions are harvested automatically — no model call, no
 * judgement — which is what makes capture cheap and honest, and also what makes
 * the store fill with things that were only ever loose ends. Without something
 * whose entire job is dropping them, a question nobody can close is a standing
 * instruction the agent cannot escape, read into every idle period for ever.
 * That is precisely the lesson `plan` paid for with `fulfilled` and `abandoned`.
 *
 * It runs in a maintenance session, on `digest`, and it is written as an
 * observer: the questions are somebody else's, presented as material to examine.
 * A step asked "are *you* still interested in this?" answers yes.
 *
 * The harness applies the verdicts. No step closes a curiosity on its own
 * authority, the same arrangement as knowledge writes going through the
 * gatekeeper and plans being written only by the plan step.
 */
export interface Pruned {
  reasoning: string;
  close: { question: string; why: string }[];
}

const schema = z.object({
  // Reasoning first, then what it justifies. A model that lists closures first
  // and explains afterwards is writing a rationale for a decision it has
  // already made, which is how a store gets emptied.
  reasoning: z.string(),
  close: z.array(z.object({ question: z.string(), why: z.string() })),
}) as z.ZodType<Pruned>;

export const prune: ModelStep<Pruned> = {
  kind: "model",
  name: "prune",
  defaultRole: "digest",
  voice: "observer",
  contextBlocks: ["open_curiosities"],
  appendix: ["maintenance_batch"],
  outputFile: "prune.md",
  buildSchema: () => schema,

  /**
   * Close nothing. A parse failure must never drop an open question: the store
   * is append-only precisely so that what the agent noticed survives, and an
   * empty list simply leaves everything for the next quiet period.
   */
  fallback: () => ({
    reasoning: "The prune could not be parsed; nothing was closed.",
    close: [],
  }),

  render: (p) =>
    [
      "# Prune",
      "",
      p.reasoning,
      "",
      "## Closed",
      "",
      p.close.length > 0
        ? p.close.map((c) => `- **${c.question}** — ${c.why}`).join("\n")
        : "_(nothing)_",
    ].join("\n"),
};
