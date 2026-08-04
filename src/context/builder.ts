import type { Config } from "../config/schema.ts";
import { truncateToTokens } from "./budget.ts";
import { BLOCK_REGISTRY, KNOWN_BLOCK_NAMES, type BlockInput } from "./blocks/index.ts";

/**
 * The single context assembler. Steps declare block names; they never assemble
 * context themselves, and they never see a block the builder did not resolve.
 */

export interface BuiltBlock {
  name: string;
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
}

export interface BuiltContext {
  blocks: BuiltBlock[];
  /** Block name -> text, ready to hand to the prompt renderer. */
  variables: Record<string, string>;
  totalEstimatedTokens: number;
}

export async function buildContext(
  blockNames: readonly string[],
  input: BlockInput,
  config: Config,
): Promise<BuiltContext> {
  const blocks: BuiltBlock[] = [];
  const variables: Record<string, string> = {};

  for (const name of blockNames) {
    const block = BLOCK_REGISTRY.get(name);
    if (!block) {
      throw new Error(
        `Unknown context block "${name}". Known blocks: ${KNOWN_BLOCK_NAMES.join(", ")}.`,
      );
    }

    const budgetTokens = config.context.budgets[name] ?? config.context.default_budget_tokens;
    const resolved = await block.resolve(input);
    const { text, truncated, estimatedTokens } = truncateToTokens(
      resolved,
      budgetTokens,
      block.keep ?? "head",
    );

    blocks.push({ name, text, estimatedTokens, budgetTokens, truncated });
    variables[name] = text;
  }

  return {
    blocks,
    variables,
    totalEstimatedTokens: blocks.reduce((sum, b) => sum + b.estimatedTokens, 0),
  };
}
