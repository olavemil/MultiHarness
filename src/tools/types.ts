import type { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config/schema.ts";

/** Everything a tool is allowed to reach. */
export interface ToolContext {
  config: Config;
  /** Opened lazily: a step with no knowledge tools never touches sqlite. */
  knowledge(): DatabaseSync;
  /** The agent's own sandbox directory. Every file path is resolved against it. */
  files: string;
  /** Sealed session output, for reading what earlier sessions concluded. */
  sessions: string;
  session: string;
  step: string;
}

/**
 * A tool is a name, a parameter schema, and a handler returning text the model
 * reads. Returning a string rather than a structure is deliberate: the result
 * goes back into a prompt, so it has to be legible to a model first.
 */
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  /** Write tools are refused for roles marked `no_tools`, and logged louder. */
  readOnly: boolean;
  run(args: T, ctx: ToolContext): Promise<string>;
}

/**
 * Registry entry. `any` is confined to this alias: the registry is
 * heterogeneous by nature, and each tool validates its own arguments before the
 * handler sees them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: string;
  durationMs: number;
  error?: string;
}
