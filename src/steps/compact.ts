import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Compaction {
  reasoning: string;
  compacted: string;
}

// Reasoning before the text it produces: working out what the blocks
// collectively say, before writing the thing that replaces them.
const schema = z.object({
  reasoning: z.string(),
  compacted: z.string(),
}) as z.ZodType<Compaction>;

/**
 * Merges one knowledge entry's accumulated blocks into a single coherent
 * statement. Runs in a maintenance session, never on the reply path.
 *
 * **One entry per session, the most-appended one.** Compaction is the first
 * thing here that rewrites what the agent knows, so it is bounded to a single
 * entry per idle run: a bad pass affects one topic, and a store that has fallen
 * behind catches up over several quiet periods rather than in one burst of
 * digest calls.
 *
 * The failure mode is losing a fact, not writing an inelegant summary — so the
 * prompt asks for completeness over brevity, and the store keeps the originals
 * regardless.
 */
export const compact: ModelStep<Compaction> = {
  kind: "model",
  name: "compact",
  defaultRole: "digest",
  // No conversational context at all. This step reads stored knowledge, and the
  // channel it happens to run in has nothing to do with what an entry says —
  // handing it `recent_messages` would invite it to fold the current
  // conversation into a durable record of something else.
  voice: "observer",
  contextBlocks: ["knowledge_entry"],
  appendix: ["maintenance_batch"],
  outputFile: "compaction.md",
  buildSchema: () => schema,

  /**
   * An empty compaction is refused by `applyCompaction`, so a parse failure
   * leaves the entry exactly as it was. Falling back to *something* would risk
   * superseding several real blocks with an apology.
   */
  fallback: () => ({
    reasoning: "The compaction could not be parsed; the entry was left untouched.",
    compacted: "",
  }),

  render: (c) =>
    [
      "# Compaction",
      "",
      c.compacted.trim() || "_(nothing was written; the entry was left as it was)_",
      "",
      "---",
      "",
      `_Reading:_ ${c.reasoning}`,
    ].join("\n"),
};
