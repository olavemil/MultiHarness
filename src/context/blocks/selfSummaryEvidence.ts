import type { ContextBlock } from "./types.ts";

/**
 * Ordered cross-channel evidence for producing the concise self-summary.
 */
export const selfSummaryEvidence: ContextBlock = {
  name: "self_summary_evidence",
  keep: "tail",
  resolve: ({ selfSummaryEvidence }) => selfSummaryEvidence?.trim() || undefined,
};
