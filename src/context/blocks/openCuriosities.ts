import type { ContextBlock } from "./types.ts";

/**
 * The open questions the agent has accumulated and not yet closed, most
 * persistent first.
 *
 * The recurrence count is shown because it is the only thing separating a loose
 * end from something the agent keeps needing and does not have — and it is a
 * fact, not an opinion. A step reading this should weigh "asked four times
 * across two conversations" quite differently from "mentioned once".
 */
export const openCuriosities: ContextBlock = {
  name: "open_curiosities",
  heading: {
    agent: "What you have been meaning to look into",
    observer: "Open questions the agent has recorded and not closed",
  },
  resolve: ({ curiosities }) => {
    if (!curiosities || curiosities.length === 0) return undefined;
    return curiosities
      .map((c) => {
        const times = `came up ${c.resurfaced} time${c.resurfaced === 1 ? "" : "s"}`;
        // Whether it was ever looked into is the other half of the judgement:
        // something asked four times and never investigated wants pursuing,
        // and something asked four times and investigated three is a question
        // that is not going to be settled this way.
        const tried =
          c.pursued > 0
            ? `, looked into ${c.pursued} time${c.pursued === 1 ? "" : "s"}`
            : ", never looked into";
        return `- ${c.question}\n  _(${times}${tried})_`;
      })
      .join("\n");
  },
};
