import type { InboundMessage } from "./types.ts";

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
}

export type Trigger = MessageTrigger | MaintenanceTrigger;

export const messageTrigger = (message: InboundMessage): MessageTrigger => ({
  kind: "message",
  channelId: message.channelId,
  message,
});

export const maintenanceTrigger = (
  channelId: string,
  reason: string,
  steps?: readonly string[],
): MaintenanceTrigger => ({
  kind: "maintenance",
  channelId,
  reason,
  ...(steps ? { steps } : {}),
});

/** The message a session was triggered by, when it was triggered by one. */
export const triggeringMessage = (trigger: Trigger): InboundMessage | undefined =>
  trigger.kind === "message" ? trigger.message : undefined;
