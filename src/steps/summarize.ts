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

    // Whether anything was said is the single most important fact about a
    // session, and it is otherwise invisible: a session that stayed silent
    // simply has no `respond` output, which reads the same as one whose reply
    // went missing. `review` judges the outcome and has to be told plainly.
    const replied = completed.some((step) => step.name === "respond");

    return [
      "# Session summary",
      "",
      replied
        ? "**A reply was sent to the channel.**"
        : "**No reply was sent — the agent chose to stay silent this session.**",
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
