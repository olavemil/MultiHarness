import type { InboundMessage } from "./types.ts";
import type { Curiosity } from "../knowledge/curiosity.ts";

/**
 * Why a session is running.
 *
 * Until now this was implicit — every session was "a message arrived", and the
 * message was the only handle a session had on its own context. harness.md has
 * always specified a scheduled run as a first-class trigger, and the sleep phase
 * needs one: retrospective work belongs in idle time, not on the reply path.
 *
 * **`channelId` is the universal part, not `message`.** Per-channel history,
 * reflection, and the last-session pointer are what a session is anchored to; a
 * message is one way of arriving at a channel. Making that explicit is what lets
 * a session run with no message at all.
 */

export interface MessageTrigger {
  kind: "message";
  channelId: string;
  message: InboundMessage;
}

export interface MaintenanceTrigger {
  kind: "maintenance";
  channelId: string;
  /** Why it fired — recorded in the session, so an unexplained run cannot happen. */
  reason: string;
  /**
   * The subset of configured maintenance steps that actually has work.
   *
   * The scheduler already had to determine this to decide whether to fire at
   * all, so passing it on costs nothing and stops the session re-deriving it —
   * and disagreeing. Absent means "run whatever config lists".
   */
  steps?: readonly string[];
  /**
   * The open question this session is working on, when it is a pursuit.
   *
   * Carried so the harness can record that it was tried, and so nothing has to
   * re-derive which of several open questions the session was actually about.
   */
  curiosity?: Curiosity | undefined;
}

/**
 * Carrying on with an unfinished plan after a reply has gone out.
 *
 * A separate session rather than a longer one: the session is the unit of
 * budget, tracing, sealed output, and reflection, and a session that ran for an
 * hour would break all four. It also makes "resume after handling the incoming
 * message" fall out for free — a continuation is just another queued session,
 * and the per-channel drain already serialises them.
 */
export interface ContinuationTrigger {
  kind: "continuation";
  channelId: string;
  /** Which iteration this is, from 1. Capped so a plan cannot run forever. */
  iteration: number;
  reason: string;
}

export type Trigger = MessageTrigger | MaintenanceTrigger | ContinuationTrigger;

export const messageTrigger = (message: InboundMessage): MessageTrigger => ({
  kind: "message",
  channelId: message.channelId,
  message,
});

export const maintenanceTrigger = (
  channelId: string,
  reason: string,
  steps?: readonly string[],
  curiosity?: MaintenanceTrigger["curiosity"],
): MaintenanceTrigger => ({
  kind: "maintenance",
  channelId,
  reason,
  ...(steps ? { steps } : {}),
  ...(curiosity ? { curiosity } : {}),
});

export const continuationTrigger = (
  channelId: string,
  iteration: number,
  reason: string,
): ContinuationTrigger => ({ kind: "continuation", channelId, iteration, reason });

/** The message a session was triggered by, when it was triggered by one. */
export const triggeringMessage = (trigger: Trigger): InboundMessage | undefined =>
  trigger.kind === "message" ? trigger.message : undefined;
