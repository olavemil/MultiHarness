import type { Config } from "../config/schema.ts";
import { buildContext, type BuiltContext } from "../context/builder.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import { computeSituation, type Situation } from "../core/situation.ts";
import { loadPrompt, SITUATIONS_DIR, type LoadedPrompt } from "../prompts/load.ts";
import { render } from "../prompts/render.ts";
import type { ModelStep } from "../steps/types.ts";

/**
 * Everything that turns a step definition into the exact text sent to a model:
 * prompt variant, situation fragment, context blocks, and variable rendering.
 *
 * Extracted so the eval harness runs the *same* assembly a live session does.
 * A harness that rebuilds the prompt itself measures its own copy of the
 * prompt, and drifts from production the first time either side is edited.
 */

export interface PreparedStep {
  prompt: LoadedPrompt;
  /** The situation fragment actually used; `named` when the agent was addressed. */
  fragmentId?: string | undefined;
  fragment: LoadedPrompt | undefined;
  situation: Situation | undefined;
  context: BuiltContext;
  renderedPrompt: string;
}

export interface PrepareArgs {
  step: ModelStep<unknown>;
  config: Config;
  blockInput: BlockInput;
  /** The agent name matched in the incoming message, if any. */
  mention: string | undefined;
  /** Verdict from the reply-target step, when it ran. */
  replyTarget?: "agent" | "other" | "nothing" | undefined;
  topic?: string;
  promptsDir?: string | undefined;
  rng?: (() => number) | undefined;
  /** Pin a prompt variant instead of sampling one. Used by the eval harness. */
  variant?: string | undefined;
}

export async function prepareModelStep(args: PrepareArgs): Promise<PreparedStep> {
  const { step, config, blockInput, mention, topic = "" } = args;

  const prompt = await loadPrompt(step.name, {
    dir: args.promptsDir,
    rng: args.rng,
    variant: args.variant,
  });
  const context = await buildContext(step.contextBlocks, blockInput, config);

  // Being named settles the reply, so the conversational-position fragments do
  // not apply: they all reason about whether an *unaddressed* message is meant
  // for the assistant. Routing a named message through `other_absent` told it
  // the message belonged to somebody else.
  const situation =
    step.situational && mention === undefined
      ? computeSituation(
          blockInput.message.text,
          blockInput.history,
          config.agent,
          8,
          args.replyTarget,
        )
      : undefined;

  const fragmentId = step.situational ? (situation?.id ?? "named") : undefined;
  const fragment = fragmentId
    ? await loadPrompt(fragmentId, { dir: SITUATIONS_DIR, rng: args.rng })
    : undefined;

  const mentionedOther = situation?.mentionsOther ?? "(nobody)";

  // Universal variables, available to every template regardless of the blocks a
  // step declares.
  const variables = {
    ...context.variables,
    ...(step.variables?.(config, blockInput) ?? {}),
    topic,
    agent_name: config.agent.name,
    agent_aliases: config.agent.aliases.join(", ") || "(none)",
    // Analyst voice: this feeds `react`, a classification step on the fast
    // model. Second person there invites the model to read "you" as itself.
    agent_mentioned: mention
      ? `Yes — the message names the assistant as "${mention}".`
      : "No — the message does not name the assistant.",
    mentioned_other: mentionedOther,
    situation: fragment ? render(fragment.text, { mentioned_other: mentionedOther }) : "",
  };

  return {
    prompt,
    fragment,
    situation,
    fragmentId,
    context,
    renderedPrompt: render(prompt.text, variables),
  };
}
