import type { ContextBlock } from "./types.ts";

/**
 * What this idle maintenance pass is doing across channels.
 *
 * Maintenance is scheduled as a global batch once everything is quiet. This
 * block makes that batch visible as structured context, so steps can reason with
 * it directly instead of inferring it from free-form topic text.
 */
export const maintenanceBatch: ContextBlock = {
  name: "maintenance_batch",
  keep: "tail",
  heading: {
    agent: "What else this maintenance pass is doing across channels",
    observer: "Cross-channel maintenance work in this idle pass",
  },
  resolve: ({ maintenanceBatch: batch }) => {
    if (!batch || batch.length === 0) return undefined;
    return batch
      .map(
        (item, index) =>
          `${index + 1}. ${item.channelId} — ${item.steps.join(", ")} — ${item.reason}`,
      )
      .join("\n");
  },
};
