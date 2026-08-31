import type { Config } from "../config/schema.ts";
import { truncateToTokens } from "./budget.ts";
import { BLOCK_REGISTRY, KNOWN_BLOCK_NAMES, type BlockInput, type Voice } from "./blocks/index.ts";
import { render } from "../prompts/render.ts";

/**
 * The single context assembler. Steps declare block names; they never assemble
 * context themselves, and they never see a block the builder did not resolve.
 *
 * Two ways a block reaches a prompt, and the difference is only how:
 *
 * - **inline** (`blocks`) — the step names it as `${block}` in its own frame.
 *   Mandatory: a step that declares one and is then run without it fails loudly
 *   rather than rendering a heading over nothing.
 * - **appendix** (`appendix`) — assembled into `${context}` in the declared
 *   order, each under a heading chosen by the step's voice, and **omitted
 *   entirely when absent**.
 *
 * Appendix order is priority order, by attention rather than by budget: the
 * first is the one the step is most likely to be wrong without.
 */

export interface BuiltBlock {
  name: string;
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
  /** How it reached the prompt. Recorded so a trace shows the assembled shape. */
  placement: "inline" | "appendix";
}

export interface BuiltContext {
  /** Only the blocks that actually resolved to something. */
  blocks: BuiltBlock[];
  /** Inline block name -> text, plus `context`, ready for the renderer. */
  variables: Record<string, string>;
  totalEstimatedTokens: number;
}

export interface BuildArgs {
  /** Mandatory blocks, referenced as `${name}` by the step's own frame. */
  blocks?: readonly string[] | undefined;
  /** Optional blocks, highest priority first, assembled into `${context}`. */
  appendix?: readonly string[] | undefined;
  input: BlockInput;
  config: Config;
  voice: Voice;
  /** Variables available to appendix headings — `${sender}` and friends. */
  headingVars?: Readonly<Record<string, string>>;
}

export async function buildContext(args: BuildArgs): Promise<BuiltContext> {
  const { input, config, voice, headingVars = {} } = args;
  const blocks: BuiltBlock[] = [];
  const variables: Record<string, string> = {};

  for (const name of args.blocks ?? []) {
    const built = await resolveOne(name, "inline", input, config);
    if (!built) {
      // A step declared this as part of its frame and it is not there. Silently
      // omitting would leave a literal `${name}` in the prompt or a dangling
      // sentence; both reach the model looking like content.
      throw new Error(
        `Context block "${name}" is required by this step's prompt but resolved to nothing. ` +
          `Either the step was queued without the input it needs, or "${name}" belongs in its appendix.`,
      );
    }
    blocks.push(built);
    variables[name] = built.text;
  }

  const sections: string[] = [];
  for (const name of args.appendix ?? []) {
    const block = lookup(name);
    if (!block.heading) {
      throw new Error(
        `Context block "${name}" has no heading and cannot be used as an appendix. ` +
          `Give it a heading per voice, or declare it inline.`,
      );
    }
    const built = await resolveOne(name, "appendix", input, config);
    if (!built) continue;

    blocks.push(built);
    const label = render(block.heading[voice], headingVars);
    sections.push(`----------\n${label}\n----------\n${built.text}`);
  }

  // Appendix blocks are deliberately kept out of `variables`: a template that
  // inlined one would render it twice, once here and once in `${context}`.
  variables.context = sections.join("\n\n");

  return {
    blocks,
    variables,
    totalEstimatedTokens: blocks.reduce((sum, b) => sum + b.estimatedTokens, 0),
  };
}

async function resolveOne(
  name: string,
  placement: "inline" | "appendix",
  input: BlockInput,
  config: Config,
): Promise<BuiltBlock | undefined> {
  const block = lookup(name);
  const resolved = await block.resolve(input);
  if (resolved === undefined || resolved.trim() === "") return undefined;

  const budgetTokens = config.context.budgets[name] ?? config.context.default_budget_tokens;
  const { text, truncated, estimatedTokens } = truncateToTokens(
    resolved,
    budgetTokens,
    block.keep ?? "head",
  );

  return { name, text, estimatedTokens, budgetTokens, truncated, placement };
}

function lookup(name: string) {
  const block = BLOCK_REGISTRY.get(name);
  if (!block) {
    throw new Error(
      `Unknown context block "${name}". Known blocks: ${KNOWN_BLOCK_NAMES.join(", ")}.`,
    );
  }
  return block;
}
