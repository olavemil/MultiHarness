import type { ContextBlock } from "./types.ts";

/**
 * The raw impression log for the person being spoken to, oldest first. Only
 * `impression` declares it; every other step reads the synthesised
 * `user_summary` instead.
 */
export const identityImpressions: ContextBlock = {
  name: "identity_impressions",
  keep: "tail",
  resolve: ({ impressions }) =>
    impressions && impressions.length > 0
      ? impressions.map((i) => `- ${i.text}`).join("\n")
      : "(nothing noticed about them yet)",
};
