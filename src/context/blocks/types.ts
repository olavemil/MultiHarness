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
  /**
   * What the agent itself last said in this channel, however far back.
   *
   * Distinct from `prior`, which is the previous *session* — and after a run of
   * declines that session contains no reply at all, leaving `reflect` to judge
   * an exchange from its own silence.
   */
  lastContribution?: { text: string; at: string; messagesSince: number } | undefined;
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
   * The agent's current background thinking, cross-channel. Latest revision only.
   */
  thinking?: string | undefined;
  /** Persistent cross-channel self-summary, latest revision only. */
  selfSummary?: string | undefined;
  /** Ordered cross-channel evidence used to refresh `selfSummary`. */
  selfSummaryEvidence?: string | undefined;
  /**
   * The last thing said in the conversation being written into — or, for a
   * person, the last thing they said anywhere.
   */
  latestMessage?: { author: string; text: string; where?: string | undefined } | undefined;
  /**
   * Channels *and* people the agent may consider writing to unprompted, already
   * filtered by the countable gates in `core/initiative.ts`.
   */
  initiativeTargets?:
    | readonly {
        ref: string;
        kind: "channel" | "dm";
        name: string;
        silentMs: number;
        agentHasSpoken: boolean;
        messagesSinceAgentSpoke: number;
        summary?: string | undefined;
      }[]
    | undefined;
  /**
   * Open questions the agent has recorded across every channel and not closed.
   *
   * The only cross-channel thing in the harness that makes it *want* something:
   * everything else here is read once something has already started it.
   */
  curiosities?: readonly { question: string; resurfaced: number; pursued: number }[] | undefined;
  /**
   * The knowledge entry a maintenance session is compacting. Present only in a
   * session that selected one, which is the only session `compact` ever runs in.
   */
  compactionTarget?:
    | { topic: string; blocks: readonly { text: string; session: string; step: string; at: string }[] }
    | undefined;
  /**
   * Cross-channel maintenance work planned in the current idle batch.
   *
   * Present on maintenance sessions only. Lets a step see what else the agent
   * is processing this idle window, without encoding that into the topic text.
   */
  maintenanceBatch?:
    | readonly { channelId: string; steps: readonly string[]; reason: string }[]
    | undefined;
}

/**
 * Who a step's prompt addresses, and therefore how its context is labelled.
 *
 * `agent` — the step *is* the agent: thinking, deciding, or speaking. Its
 * context is labelled as the agent's own, because the alternative is a local
 * model reading its own research notes as something the sender wrote.
 *
 * `observer` — the step judges material from outside the conversation. The
 * agent is one named participant among several and is never addressed as "you".
 */
export type Voice = "agent" | "observer";

/**
 * A named, budgeted piece of context. Steps declare block names; only the
 * builder resolves them. Adding a block is a new file plus a registry line —
 * never a branch in shared code.
 */
export interface ContextBlock {
  name: string;
  /** Which end survives truncation. Defaults to `head`. */
  keep?: KeepEnd;
  /**
   * Heading this block gets when it is rendered as an appendix, one per voice.
   *
   * The same `prior_step_output` is "What you worked out earlier in this
   * session" to the step that wrote it and "Working notes produced during the
   * session" to the step judging it. That heading is the whole mechanism for
   * telling a model which of the text in front of it is its own — headings may
   * reference `${sender}` and the other universal variables.
   *
   * Absent means the block is inline-only and may not be used as an appendix.
   */
  heading?: Record<Voice, string>;
  /**
   * `undefined` means the block has nothing to say and is omitted entirely —
   * no heading, no placeholder.
   *
   * Placeholder prose was the previous answer and it is worse than silence: `(no
   * preparatory steps ran)` arrives under a heading, in the same markdown, as
   * indistinguishable from content. A step handed a form with most fields marked
   * not-applicable answers from the form.
   */
  resolve(input: BlockInput): string | undefined | Promise<string | undefined>;
}
