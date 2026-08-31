import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface SelfSummaryRevision {
  summary: string;
}

const schema = z.object({
  summary: z.string(),
}) as z.ZodType<SelfSummaryRevision>;

/**
 * Concise cross-channel self-summary for persistent identity and continuity.
 *
 * Runs on `fast` in neutral voice so it stays cheap and factual.
 */
export const selfSummary: ModelStep<SelfSummaryRevision> = {
  kind: "model",
  name: "self_summary",
  defaultRole: "fast",
  voice: "observer",
  contextBlocks: ["self_summary_evidence"],
  appendix: ["self_summary", "background_thinking"],
  outputFile: "self_summary.md",
  buildSchema: () => schema,

  fallback: () => ({
    summary: "Self-summary could not be parsed; keeping the previous one.",
  }),

  render: (s) => ["# Self summary", "", s.summary].join("\n"),
};
