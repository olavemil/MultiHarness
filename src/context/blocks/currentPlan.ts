import type { ContextBlock } from "./types.ts";

/**
 * The durable plan this channel is working to, if any.
 *
 * Reads as absent when the plan was fulfilled or abandoned, not merely when none
 * was ever written. That distinction is the whole reason closing exists: a plan
 * that could not be closed would be injected into every future session forever,
 * a standing instruction with no way out.
 */
export const currentPlan: ContextBlock = {
  name: "current_plan",
  resolve: ({ plan }) => {
    if (!plan) return "(no plan is running in this channel)";
    const outstanding =
      plan.outstanding.length > 0
        ? plan.outstanding.map((item) => `- ${item}`).join("\n")
        : "- (nothing listed)";
    const lines = [`**Goal:** ${plan.goal}`, "", "**Outstanding:**", outstanding];
    if (plan.artifactState.length > 0) {
      lines.push(
        "",
        "**Files this plan is producing:**",
        // Sizes included so the step can see what exists without a tool call,
        // and so a claim that something is finished can be read against it.
        ...plan.artifactState.map(
          (a) => `- \`${a.path}\` — ${a.exists ? `${a.size} bytes` : "not written yet"}`,
        ),
      );
    }
    return lines.join("\n");
  },
};
