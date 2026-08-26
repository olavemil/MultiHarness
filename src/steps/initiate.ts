import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import type { ModelStep } from "./types.ts";

/**
 * Whether there is something worth saying to somebody right now, and where.
 *
 * **The first path in the harness that writes to a channel nobody prompted**,
 * and the one that most needs its guards stated rather than assumed. Everything
 * else the agent says is an answer: somebody spoke, and the whole entry path
 * exists to decide whether and how to reply. This decides to speak into silence.
 *
 * A separate step rather than a branch in the maintenance queue, and the roadmap
 * says why: fusing "is there housekeeping to do?" with "should I start a
 * conversation?" would repeat the `react`/`schedule` mistake — two unrelated
 * questions in one constrained decode.
 *
 * **It decides and composes in one call, which looks like the same mistake and
 * is not.** For an interjection the message *is* the decision: there is no
 * honest way to answer "is this worth saying?" without knowing what it would
 * say, which is the lesson `stance` already encodes by asking for what you would
 * actually say before scoring it. Splitting them would produce a step that
 * commits to speaking and a second one that has to find something to speak
 * about.
 *
 * The countable guards live outside the prompt, in `core/initiative.ts`: how
 * long a channel must have been quiet, how long since the agent last started
 * something, and whether anything is waiting. This step is only ever asked about
 * channels that already passed them.
 */
export interface Initiative {
  /** Why any of this is worth saying now. Decoded first. */
  reasoning: string;
  /**
   * Who to write to, and what about. Empty is the ordinary answer.
   *
   * `target` is compiled from the refs that passed the countable gates, so the
   * model cannot name a room or a person it was not offered — the same
   * arrangement as `selectable_steps` and the reply-target ids.
   *
   * **`intent` is one line, not the message.** Each target gets its own
   * `outreach` call to write the actual text, told who else is being written to
   * so it does not send four people the same paragraph. But the intent is
   * decoded *here*, because "is this worth saying?" cannot be answered honestly
   * without knowing what would be said — the same reason `stance` asks what you
   * would actually say before scoring it. A selection step with no intent picks
   * targets and leaves the composing step to find something to tell them.
   */
  targets: { target: string; intent: string }[];
}

function buildSchema(_config: Config, input: BlockInput): z.ZodType<Initiative> {
  const refs = (input.initiativeTargets ?? []).map((t) => t.ref);
  const target =
    refs.length > 0
      ? z.enum(refs as [string, ...string[]])
      : // Nothing was offered, so nothing is decodable. `max(0)` below makes
        // that a schema-level guarantee rather than a convention.
        z.string();

  // `reasoning` before the targets it justifies. Same lever as everywhere else.
  return z.object({
    reasoning: z.string(),
    targets:
      refs.length > 0
        ? z.array(z.object({ target, intent: z.string() }))
        : z.array(z.object({ target, intent: z.string() })).max(0),
  }) as z.ZodType<Initiative>;
}

export const initiate: ModelStep<Initiative> = {
  kind: "model",
  name: "initiate",
  defaultRole: "reasoning",
  voice: "agent",
  contextBlocks: ["initiative_targets"],
  appendix: [
    "maintenance_batch",
    "background_thinking",
    "open_curiosities",
    "current_plan",
    "prior_step_output",
  ],
  outputFile: "initiative.md",
  buildSchema,

  /**
   * Say nothing. Every other fallback in the harness leans toward answering,
   * because silence where an answer was expected reads as being ignored — this
   * one leans the other way for exactly the same reason inverted: nobody is
   * waiting, nobody asked, and a parse failure is not a reason to interrupt
   * somebody's day.
   */
  fallback: () => ({
    reasoning: "The initiative could not be parsed; staying quiet.",
    targets: [],
  }),

  // Read-only, and no web. Deciding whether to say something is not a research
  // task: the material is what the agent already has, and a step that could go
  // and look would turn a quiet moment into a slow one for no gain. `session_read`
  // is what lets it check what a channel was actually about — the latest
  // `request.md` is that channel's own restatement of what it was doing.
  defaultTools: ["knowledge_search", "knowledge_read", "session_list", "session_read", "file_list", "file_read"],

  render: (i) =>
    [
      "# Initiative",
      "",
      i.reasoning,
      "",
      "## Writing to",
      "",
      i.targets.length > 0
        ? i.targets.map((t) => `- \`${t.target}\` — ${t.intent}`).join("\n")
        : "_(nobody)_",
    ].join("\n"),
};

/** The targets worth acting on: a ref with nothing to say is not one. */
export const chosen = (i: Initiative): { target: string; intent: string }[] =>
  i.targets.filter((t) => t.target.trim() !== "" && t.intent.trim() !== "");
