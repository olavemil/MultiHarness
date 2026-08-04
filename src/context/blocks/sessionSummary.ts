import type { ContextBlock } from "./types.ts";

/** The `summarize` step's output — what ran, in what order, and how long it took. */
export const sessionSummary: ContextBlock = {
  name: "session_summary",
  resolve: ({ completed }) => {
    const summary = completed.find((step) => step.name === "summarize");
    return summary ? summary.content.trim() : "(no session summary was produced)";
  },
};
