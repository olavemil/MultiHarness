import type { Config } from "../config/schema.ts";
import { buildContext, type BuiltContext } from "../context/builder.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import { computeSituation, type Situation } from "../core/situation.ts";
import { agentStanding, describeStanding, type Standing } from "../core/standing.ts";
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
  /** Whether the message continues the agent's own subject, when it was measured. */
  standing?: Standing | undefined;
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
  /** What the session has left to spend, for steps that can queue more work. */
  budgetRemaining?: string | undefined;
  /**
   * Whether the reply being written may name anybody, decided in code from
   * `stance`'s interest and stated to the prompt as settled fact. See
   * `core/mentionPolicy.ts` for why it is not left to the prompt's judgement.
   */
  mentionPolicy?: string | undefined;
  /** Who an `outreach` is writing to. */
  target?: string | undefined;
  /**
   * Everybody else being written to in the same sitting.
   *
   * Without it each message is composed as though it were the only one, so four
   * people get four variations on one paragraph and one of them is told in
   * confidence something another is about to hear. A person writing three
   * messages knows they are writing three.
   */
  otherTargets?: readonly string[] | undefined;
}

export async function prepareModelStep(args: PrepareArgs): Promise<PreparedStep> {
  const { step, config, blockInput, mention, topic = "" } = args;

  const prompt = await loadPrompt(step.name, {
    dir: args.promptsDir,
    rng: args.rng,
    variant: args.variant,
  });

  // Available to appendix headings, which is why they are computed before the
  // context rather than merged into it afterwards: "What you know about
  // ${sender}" has to name somebody.
  const headingVars = {
    sender: blockInput.identity.displayName,
    agent_name: config.agent.name,
    topic,
  };

  const context = await buildContext({
    blocks: step.contextBlocks,
    appendix: step.appendix,
    input: blockInput,
    config,
    voice: step.voice,
    headingVars,
  });

  // Being named settles the reply, so the conversational-position fragments do
  // not apply: they all reason about whether an *unaddressed* message is meant
  // for the agent. Routing a named message through `other_absent` told it
  // the message belonged to somebody else.
  // No message means no conversational position to route on: every fragment
  // reasons about where an *arriving message* sits relative to the agent, and a
  // maintenance session has none.
  const routed =
    step.situational && mention === undefined && blockInput.message !== undefined;

  // Measured here rather than by the caller, so the eval harness and a live
  // session cannot diverge on it — the drift this file exists to prevent.
  const standing = routed
    ? await agentStanding(config, blockInput.history, blockInput.message!.text)
    : undefined;

  const situation = routed
    ? computeSituation(
        blockInput.message!.text,
        blockInput.history,
        config.agent,
        8,
        args.replyTarget,
        standing?.related,
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
    // Static, from config. The self-revising version — a cross-channel document
    // the agent edits about itself — is roadmap 4c and inherits the impression
    // loop's guards; this is the half that costs nothing.
    agent_persona: config.agent.personality,
    // Who the step is talking to, or about. Named rather than left to
    // `incoming_message` to prefix, so a subjective frame can address them and
    // an appendix heading can say whose file it is.
    sender: blockInput.identity.displayName,
    mentioned_other: mentionedOther,
    budget_remaining: args.budgetRemaining ?? "Not constrained.",
    target: args.target ?? "",
    other_targets:
      args.otherTargets && args.otherTargets.length > 0
        ? args.otherTargets.join(", ")
        : "nobody else",
    mention_policy:
      args.mentionPolicy ??
      "@mention somebody only where the reply genuinely needs their attention.",
    standing: describeStanding(standing),
    // Fragments get the same universal scalars the frames do. They used to get
    // only the two they were known to use, so a fragment that grew a `${…}`
    // failed at render time — the guard working, but at the cost of a dead
    // session rather than a compile error.
    situation: fragment
      ? render(fragment.text, {
          mentioned_other: mentionedOther,
          standing: describeStanding(standing),
          agent_name: config.agent.name,
          agent_persona: config.agent.personality,
          sender: blockInput.identity.displayName,
        })
      : "",
  };

  return {
    prompt,
    fragment,
    situation,
    standing,
    fragmentId,
    context,
    renderedPrompt: render(prompt.text, variables),
  };
}
