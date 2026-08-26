import type { ContextBlock } from "./types.ts";

/** The `summarize` step's output — what ran, in what order, and how long it took. */
export const sessionSummary: ContextBlock = {
  name: "session_summary",
  heading: {
    agent: "What this session did",
    observer: "What the session did, and how long it took",
  },
  resolve: ({ completed }) => completed.find((step) => step.name === "summarize")?.content.trim(),
};
