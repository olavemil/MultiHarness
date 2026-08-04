import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

export interface Reaction {
  reason: string;
  respond: boolean;
}

/**
 * One question only: should this be answered? How a session is structured is
 * `plan`'s job, and separating them lets a named message skip this entirely.
 */
function buildSchema(_config: Config): z.ZodType<Reaction> {
  // Reasoning before the field it justifies.
  return z.object({
    reason: z.string(),
    respond: z.boolean(),
  }) as z.ZodType<Reaction>;
}

export const react: ModelStep<Reaction> = {
  kind: "model",
  name: "react",
  defaultRole: "fast",
  contextBlocks: ["user_summary", "recent_messages", "incoming_message", "reflection"],
  situational: true,
  outputFile: "reaction.md",
  buildSchema,

  /**
   * Responding is the safe default. A parse failure is a harness problem, and
   * going silent because of one would look to the person waiting exactly like
   * being ignored.
   */
  fallback: () => ({
    reason: "Reaction could not be parsed; defaulting to a direct reply.",
    respond: true,
  }),

  render: (reaction) =>
    [
      "# Reaction",
      "",
      `**Respond:** ${reaction.respond ? "yes" : "no"}`,
      "",
      `**Reason:** ${reaction.reason}`,
    ].join("\n"),
};
