import type { ChannelMessage, CompletedStep, Identity, InboundMessage } from "../../core/types.ts";
import type { PriorSession } from "../../store/priorSession.ts";
import type { KeepEnd } from "../budget.ts";

/** Everything a context block is allowed to see. */
export interface BlockInput {
  message: InboundMessage;
  /** Channel history, oldest first, excluding `message` itself. */
  history: readonly ChannelMessage[];
  identity: Identity;
  /** Steps already sealed in this session, in execution order. */
  completed: readonly CompletedStep[];
  /** The previous session in this channel. Absent on the first one. */
  prior?: PriorSession | undefined;
}

/**
 * A named, budgeted piece of context. Steps declare block names; only the
 * builder resolves them. Adding a block is a new file plus a registry line —
 * never a branch in shared code.
 */
export interface ContextBlock {
  name: string;
  /** Which end survives truncation. Defaults to `head`. */
  keep?: KeepEnd;
  resolve(input: BlockInput): string | Promise<string>;
}
