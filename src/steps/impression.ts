import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Impression {
  reading: string;
  summary: string;
}

const schema = z.object({
  reading: z.string(),
  summary: z.string(),
}) as z.ZodType<Impression>;

/**
 * Synthesises accumulated impressions of one person into a current summary.
 *
 * Runs after `review`, and only once enough impressions have piled up to be
 * worth reading as a pattern — synthesising after every exchange would just
 * restate the latest one and call it a trend.
 *
 * `summary` replaces the identity's running summary, which is what every step
 * sees through `user_summary`. The impressions it was built from are never
 * rewritten, so a summary that has drifted can always be checked against them.
 */
export const impression: ModelStep<Impression> = {
  kind: "model",
  name: "impression",
  defaultRole: "digest",
  contextBlocks: ["user_summary", "identity_impressions"],
  outputFile: "impression.md",
  buildSchema: () => schema,

  /** Keeping the existing summary is safer than replacing it with a guess. */
  fallback: () => ({
    reading: "Impressions could not be synthesised this session.",
    summary: "",
  }),

  render: (i) =>
    ["# Impression", "", i.reading, "", "## Current summary", "", i.summary || "_(unchanged)_"].join(
      "\n",
    ),
};
