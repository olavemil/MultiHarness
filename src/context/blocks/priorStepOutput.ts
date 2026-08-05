import type { ContextBlock } from "./types.ts";

/** Steps whose output is bookkeeping rather than work product. */
const STRUCTURAL = new Set(["react", "restate", "summarize"]);

/**
 * Substantive output of steps already sealed in this session.
 *
 * `react`'s decision is a routing artefact and `summarize`'s table is
 * bookkeeping — neither is material for writing a reply or judging one, and
 * `session_summary` already carries the latter for steps that want it.
 *
 * `restate` is excluded for both reasons at once: every step that reads this
 * block also declares `request`, so including it here would spend the budget
 * twice, and it would arrive under "what earlier steps produced" — framing a
 * restatement of the question as though it were an answer to it.
 */
export const priorStepOutput: ContextBlock = {
  name: "prior_step_output",
  resolve: ({ completed }) => {
    const relevant = completed.filter((step) => !STRUCTURAL.has(step.name));
    if (relevant.length === 0) return "(no preparatory steps ran)";

    return relevant
      .map((step) => {
        const heading = step.topic ? `## ${step.name} — ${step.topic}` : `## ${step.name}`;
        return `${heading}\n\n${step.content.trim()}`;
      })
      .join("\n\n");
  },
};
