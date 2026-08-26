import type { ContextBlock } from "./types.ts";

/**
 * The raw impression log for the person being spoken to, oldest first. Only
 * `impression` declares it; every other step reads the synthesised
 * `user_summary` instead.
 */
export const identityImpressions: ContextBlock = {
  name: "identity_impressions",
  keep: "tail",
  heading: {
    agent: "Everything you have noticed about them, oldest first",
    observer: "Everything recorded about this person, oldest first",
  },
  resolve: ({ impressions }) =>
    impressions && impressions.length > 0
      ? impressions.map((i) => `- ${i.text}`).join("\n")
      : undefined,
};
