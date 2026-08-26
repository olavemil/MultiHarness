import type { ContextBlock } from "./types.ts";

/** Steps whose output is bookkeeping rather than work product. */
const STRUCTURAL = new Set(["read", "stance", "restate", "schedule", "summarize"]);

/**
 * Substantive output of steps already sealed in this session.
 *
 * `read` and `stance` are routing artefacts and `summarize`'s table is
 * bookkeeping — neither is material for writing a reply or judging one, and
 * `session_summary` already carries the latter for steps that want it.
 *
 * `restate` is excluded for both reasons at once: every step that reads this
 * block also declares `request`, so including it here would spend the budget
 * twice, and it would arrive under "what you worked out earlier" — framing a
 * restatement of the question as though it were an answer to it.
 *
 * The `draft` step is excluded too, but by its readers rather than here:
 * `respond` declares `draft` as its own first appendix so a written reply
 * arrives labelled as one, instead of buried among research findings.
 */
export const priorStepOutput: ContextBlock = {
  name: "prior_step_output",
  heading: {
    agent: "What you worked out earlier in this session",
    observer: "Working notes produced during the session",
  },
  resolve: ({ completed }) => {
    const relevant = completed.filter(
      (step) => !STRUCTURAL.has(step.name) && step.name !== "draft",
    );
    if (relevant.length === 0) return undefined;

    return relevant
      .map((step) => {
        const heading = step.topic ? `### ${step.name} — ${step.topic}` : `### ${step.name}`;
        return `${heading}\n\n${step.content.trim()}`;
      })
      .join("\n\n");
  },
};
