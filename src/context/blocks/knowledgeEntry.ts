import type { ContextBlock } from "./types.ts";

/**
 * The knowledge entry being compacted, block by block, oldest first.
 *
 * Each is labelled with where it came from, because provenance is part of the
 * material: a note written by `research` three sessions ago and one written
 * yesterday may well disagree, and knowing which is later is what settles it.
 */
export const knowledgeEntry: ContextBlock = {
  name: "knowledge_entry",
  resolve: ({ compactionTarget }) => {
    if (!compactionTarget || compactionTarget.blocks.length === 0) {
      return "(no entry was selected for compaction)";
    }
    return compactionTarget.blocks
      .map((b, i) => `### Note ${i + 1} — ${b.step}, session ${b.session}, ${b.at}\n\n${b.text}`)
      .join("\n\n");
  },
};
