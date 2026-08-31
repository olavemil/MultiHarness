import { z } from "zod";
import type { ModelStep } from "./types.ts";

/**
 * The agent thinking on its own account, with nobody waiting.
 *
 * **Distinct from `reason`, and the difference is not the model.** `reason` is
 * given a topic by `schedule` and works a question somebody asked; its output is
 * sealed into the session and read by `respond` minutes later. This has no
 * assigned topic, runs only in idle time, and writes to a document that outlives
 * every session — so it is the one step whose job is the agent's own situation
 * rather than anybody's question.
 *
 * It has the tools to actually look: the knowledge store, its own files, and its
 * own past sessions. Without them it would be a model musing over a context
 * window, which is the shape that produces confident prose about nothing. With
 * them it can check what a plan actually says, read what it wrote last week, and
 * notice that two things it recorded separately are the same thing.
 *
 * **Nobody sees this and nothing acts on it directly**, which is what makes it
 * safe to let run free. It is read by the steps that decide what to do next —
 * `plan`, `research`, and `initiate` — as continuity rather than instruction.
 */
export interface Pondering {
  /** The working. Not kept; it is the thinking, not the record of it. */
  thinking: string;
  /**
   * What to carry forward, replacing the previous revision.
   *
   * Deliberately a *replacement* rather than an append. The revisions are all
   * kept on disk, so nothing is lost — but what later steps read has to be the
   * agent's current view, not an accreting transcript nobody prunes. That was
   * the failure `compact` exists to undo in the knowledge store.
   */
  carry_forward: string;
}

const schema = z.object({
  thinking: z.string(),
  carry_forward: z.string(),
}) as z.ZodType<Pondering>;

export const ponder: ModelStep<Pondering> = {
  kind: "model",
  name: "ponder",
  defaultRole: "reasoning",
  voice: "agent",
  contextBlocks: [],
  appendix: [
    "maintenance_batch",
    "background_thinking",
    "current_plan",
    "open_curiosities",
    "prior_step_output",
    "recent_messages",
  ],
  outputFile: "pondering.md",
  buildSchema: () => schema,
  defaultTools: [
    "knowledge_search",
    "knowledge_read",
    "file_list",
    "file_read",
    "file_write",
    "session_list",
    "session_read",
  ],

  /**
   * Carry nothing forward. An unparsed revision must not replace a real one
   * with an apology — `writeThinking` refuses an empty body for exactly this,
   * so the previous revision simply stands.
   */
  fallback: () => ({
    thinking: "The pondering could not be parsed.",
    carry_forward: "",
  }),

  render: (p) =>
    ["# Pondering", "", p.thinking, "", "## Carried forward", "", p.carry_forward].join("\n"),
};
