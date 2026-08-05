import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Research {
  findings: string;
  gaps: string[];
}

const schema = z.object({
  findings: z.string(),
  gaps: z.array(z.string()),
}) as z.ZodType<Research>;

/**
 * Gathers what is needed to answer, and records durable facts as it goes.
 *
 * The first step that runs a tool loop, and the only one that writes to the
 * knowledge store. Expensive by design — `react` should choose it when the
 * answer actually depends on something the agent does not already have in
 * front of it.
 */
export const research: ModelStep<Research> = {
  kind: "model",
  name: "research",
  defaultRole: "reasoning",
  contextBlocks: ["user_summary", "recent_messages", "incoming_message", "request", "reflection"],
  outputFile: "research.md",
  buildSchema: () => schema,
  defaultTools: ["knowledge_search", "knowledge_read", "knowledge_write"],

  /**
   * An empty finding is honest and harmless: `respond` reads it as "nothing
   * useful came back" and answers from what it knows. Inventing findings here
   * would put fabrications into the reply.
   */
  fallback: () => ({
    findings: "Research produced no usable result this session.",
    gaps: [],
  }),

  render: (r) => {
    const gaps =
      r.gaps.length > 0 ? r.gaps.map((g) => `- ${g}`).join("\n") : "_(none identified)_";
    return ["# Research", "", r.findings, "", "## Still unknown", "", gaps].join("\n");
  },
};
