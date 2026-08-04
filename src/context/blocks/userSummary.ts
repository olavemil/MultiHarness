import type { ContextBlock } from "./types.ts";

export const userSummary: ContextBlock = {
  name: "user_summary",
  resolve: ({ identity }) => {
    const known = identity.summary.trim();
    const aliases = identity.aliases.length > 0 ? ` (also: ${identity.aliases.join(", ")})` : "";
    return known
      ? `${identity.displayName}${aliases}\n\n${known}`
      : `${identity.displayName}${aliases}\n\n(nothing known about them yet)`;
  },
};
