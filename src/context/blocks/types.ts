import type { ChannelMessage, CompletedStep, Identity, InboundMessage } from "../../core/types.ts";
import type { Plan } from "../../store/planStore.ts";
import type { StoredReaction } from "../../store/reactionStore.ts";
import type { PriorSession } from "../../store/priorSession.ts";
import type { KeepEnd } from "../budget.ts";

/** Everything a context block is allowed to see. */
export interface BlockInput {
  /**
   * Absent on a session no message triggered — a scheduled or idle run. Blocks
   * that need one say so rather than assuming it is there.
   */
  message?: InboundMessage | undefined;
  /** Channel history, oldest first, excluding `message` itself. */
  history: readonly ChannelMessage[];
  identity: Identity;
  /** Steps already sealed in this session, in execution order. */
  completed: readonly CompletedStep[];
  /** The previous session in this channel. Absent on the first one. */
  prior?: PriorSession | undefined;
  /**
   * The channel's durable plan, when one is running. Absent once it is
   * fulfilled or abandoned, so a closed plan stops reaching any step.
   */
  plan?: Plan | undefined;
  /**
   * Reactions standing on the agent's own recent messages. The most direct
   * evidence available about how an answer landed, and cheap for a person to
   * send — but only `reflect` reads them.
   */
  reactions?: readonly StoredReaction[] | undefined;
  /** Accumulated impressions of `identity`, oldest first. */
  impressions?: readonly { text: string }[] | undefined;
  /**
   * `reflect`'s finding that the previous session misread what was asked, when
   * it found one. Passed as data rather than parsed back out of the sealed
   * markdown, the same way `impressions` is.
   */
  requestCorrection?: string | undefined;
  /**
   * Messages that arrived after the session began, with the supervisor's verdict
   * on each. Absent unless something interrupted the session.
   */
  arrivals?: readonly { author: string; text: string; verdict: string }[] | undefined;
  /**
   * The knowledge entry a maintenance session is compacting. Present only in a
   * session that selected one, which is the only session `compact` ever runs in.
   */
  compactionTarget?:
    | { topic: string; blocks: readonly { text: string; session: string; step: string; at: string }[] }
    | undefined;
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
