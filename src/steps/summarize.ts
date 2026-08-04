import type { ComputedStep } from "./types.ts";

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/**
 * Structured listing of what ran and how long it took. Deliberately not a model
 * call: it is a record, and a model would only add the chance of getting it
 * wrong.
 */
export const summarize: ComputedStep = {
  kind: "computed",
  name: "summarize",
  outputFile: "summary.md",

  compute: ({ sessionNumber, startedAt, completed }) => {
    const rows = completed.map((step) => {
      const flags: string[] = [];
      if (step.variantId) flags.push(step.variantId);
      if (step.fellBack) flags.push("**fell back to default**");

      return `| ${step.name} | ${step.topic || "—"} | ${seconds(step.durationMs)} | ${
        flags.join(", ") || "—"
      } |`;
    });

    return [
      "# Session summary",
      "",
      // Counts only what has run: the closing steps, this one included, are
      // still in flight. Saying "N steps" flat would understate the session.
      `Session ${String(sessionNumber).padStart(6, "0")} · ` +
        `${completed.length} step${completed.length === 1 ? "" : "s"} before this summary · ` +
        `${seconds(Date.now() - startedAt)} so far`,
      "",
      "| step | topic | duration | notes |",
      "| --- | --- | --- | --- |",
      ...rows,
    ].join("\n");
  },
};
