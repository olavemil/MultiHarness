import { z } from "zod";
import type { ModelStep } from "./types.ts";
import type { PlanStatus } from "../store/planStore.ts";

export interface PlanRevision {
  reasoning: string;
  status: PlanStatus;
  goal: string;
  outstanding: string[];
  /** Files under `files/` this plan exists to produce. May be empty. */
  artifacts: string[];
  changed: string;
}

// `status` decodes before the fields it governs: whether the plan is still
// running is the question, and `outstanding` follows from it rather than the
// other way round. A model that writes a list of remaining work first will not
// then declare the plan finished.
const schema = z.object({
  reasoning: z.string(),
  status: z.enum(["active", "fulfilled", "abandoned"]),
  goal: z.string(),
  outstanding: z.array(z.string()),
  artifacts: z.array(z.string()),
  changed: z.string(),
}) as z.ZodType<PlanRevision>;

/**
 * Writes or revises the channel's durable plan — the capability jump from
 * answering each message in isolation to working on something over days.
 *
 * **The only writer.** `writePlanRevision` is called by the harness for this
 * step's output and nowhere else; no tool exposes plan writing. A step cannot
 * revise a plan on its own authority, the same arrangement as knowledge writes
 * going through the gatekeeper and enforced the way `no_tools` is.
 *
 * **Closing is a first-class outcome.** A plan nothing can close becomes a
 * standing instruction the agent cannot escape: every later session reads it,
 * acts on it, and there is no path by which it ever stops. `fulfilled` and
 * `abandoned` both make it read as absent, and `abandoned` exists so that a plan
 * which turned out to be wrong can be dropped rather than pursued to exhaustion.
 */
export const plan: ModelStep<PlanRevision> = {
  kind: "model",
  name: "plan",
  defaultRole: "reasoning",
  contextBlocks: [
    "recent_messages",
    "incoming_message",
    "request",
    "current_plan",
    "prior_step_output",
  ],
  outputFile: "plan.md",
  buildSchema: () => schema,

  /**
   * Leaves the existing plan alone. An unparsed revision must not close a plan
   * or invent a goal — the harness skips the write when the goal comes back
   * empty, so this is a no-op rather than a destructive default.
   */
  fallback: () => ({
    reasoning: "The plan could not be parsed; the existing plan is unchanged.",
    status: "active",
    goal: "",
    outstanding: [],
    artifacts: [],
    changed: "",
  }),

  render: (p) => {
    const outstanding =
      p.outstanding.length > 0
        ? p.outstanding.map((item) => `- ${item}`).join("\n")
        : "_(nothing outstanding)_";
    const artifacts =
      p.artifacts.length > 0
        ? p.artifacts.map((a) => `- \`${a}\``).join("\n")
        : "_(none — this plan produces a decision, not a file)_";
    return [
      `# Plan — ${p.status}`,
      "",
      p.goal.trim() || "_(no plan was written)_",
      "",
      "## Outstanding",
      "",
      outstanding,
      "",
      "## Artifacts",
      "",
      artifacts,
      "",
      "## What changed",
      "",
      p.changed.trim() || "_(first revision)_",
      "",
      "---",
      "",
      `_Reading:_ ${p.reasoning}`,
    ].join("\n");
  },
};
