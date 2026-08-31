import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { ModelStep } from "./types.ts";

/**
 * Has the agent got anything worth saying here? The second half of what `react`
 * used to do, and the only subjective step on the entry path.
 *
 * **This is the question that had to move.** `interest` was decoded in analyst
 * voice, about a third party, from a prompt that never named what the agent is
 * like or what it knows about the person speaking. "How much does the agent have
 * to add" is not a fact about the transcript — it is the agent weighing its own
 * knowledge and its own standing, and it is the one judgement on the entry path
 * that genuinely belongs to it.
 *
 * So it gets the agent's voice, the persona, and what is known about the sender,
 * and it gets the situation fragment — which had been asking an agent-shaped
 * question ("does this reach back to something the agent said?") in the third
 * person, because it was wedged into an objective call.
 *
 * **It decides nothing on its own.** `interest` is a weight, not a verdict:
 * `core/participation.ts` interpolates the probability between
 * `model_no_weight` and `model_yes_weight` from it, and the draw settles it. The
 * verdict itself is derived in code from this, `read`, and the draw — see
 * `steps/verdict.ts`. Every judgement moved out of a prompt is one fewer thing a
 * model swap can break, and this was the last one on the entry path.
 */
export interface Stance {
  reason: string;
  /**
   * 0 to 1.
   *
   * A continuous value rather than a boolean because "barely worth saying" and
   * "I have a real point" both arrived as `true` and threw away everything the
   * step knew. **0 is load-bearing**: with nothing asked of the agent it is what
   * separates staying out of somebody else's exchange from joining it.
   */
  interest: number;
  /**
   * How the agent would mark the message, if it turns out nothing more is
   * wanted. Any emoji name — `[session.acknowledgements]` suggests some, and
   * suggests only.
   *
   * Decoded here rather than in a call of its own because `stance` already runs
   * on the acknowledging path and is already the step that knows what kind of
   * nothing this is. The fixed `+1` it replaces was the agent's single answer to
   * thanks, to jokes, to good news and to being agreed with — four different
   * things wearing one face, and much more visible since a bare mention started
   * deriving to `acknowledge` instead of forcing a reply.
   */
  reaction: string;
}

/** The configured suggestions and their meanings, rendered for a prompt. */
export function acknowledgementSuggestions(config: Config): string {
  const entries = Object.entries(config.session.acknowledgements);
  if (entries.length === 0) return `- \`:${config.session.acknowledge_emoji || "+1"}:\``;
  return entries.map(([emoji, when]) => `- \`:${emoji}:\` — ${when}`).join("\n");
}

function buildSchema(_config: Config): z.ZodType<Stance> {
  // Reason before the number it justifies — the same lever as everywhere else
  // here. `reaction` decodes **last**, after `interest` is committed to.
  // `interest` is the load-bearing field on this step: it gates the verdict, the
  // participation draw, and whether the reply may name anybody. A third field
  // decoded ahead of it would be a third thing that could move it, and this
  // file already records what a fifth decoded field did to `react`.
  return z.object({
    reason: z.string(),
    interest: z.number().min(0).max(1),
    // **Free text, not an enum over the configured list.** Compiling the
    // vocabulary into the schema meant the agent could only ever pick from
    // something somebody wrote for it, which is safe and is also why it never
    // read like a person reacting. The suggestions are in the prompt; whether
    // an emoji actually exists is Slack's answer to give, and it gives it as
    // `invalid_name`. `core/emoji.ts` checks only that the name has the shape
    // of one, so a bad guess costs a missing reaction rather than a session.
    reaction: z.string(),
  }) as z.ZodType<Stance>;
}

export const stance: ModelStep<Stance> = {
  kind: "model",
  name: "stance",
  defaultRole: "fast",
  voice: "agent",
  // The message, and the one question the situation routing selected. Both
  // mandatory: without either there is nothing to have a stance about.
  contextBlocks: ["incoming_message"],
  situational: true,
  appendix: ["self_summary", "user_summary", "recent_messages", "reflection"],
  outputFile: "stance.md",
  buildSchema,

  /**
   * The midpoint. A parse failure is a harness problem and should neither
   * silence the agent nor make it eager — 0.5 leaves the draw where the rest of
   * the weights put it.
   */
  fallback: (config) => ({
    reason: "The stance could not be parsed; taking no view either way.",
    interest: 0.5,
    // The configured fallback, which is required to be something never wrong.
    reaction: config.session.acknowledge_emoji || "+1",
  }),

  /**
   * The vocabulary and its meanings, rendered for the prompt. They live in
   * config rather than in the prompt file because the list is a property of a
   * workspace — custom emoji differ per Slack — so a meaning that did not travel
   * with its emoji would be wrong the moment anybody edited the list.
   */
  variables: (config) => ({ acknowledge_options: acknowledgementSuggestions(config) }),

  render: (value) =>
    [
      "# Stance",
      "",
      `**Interest:** ${value.interest.toFixed(2)}`,
      `**Would mark it:** :${value.reaction}:`,
      "",
      value.reason,
    ].join("\n"),
};
