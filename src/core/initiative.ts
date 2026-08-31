import type { Config } from "../config/schema.ts";
import type { Identity } from "./types.ts";
import type { ChannelSurvey } from "../store/channelRegistry.ts";

/**
 * Who the agent may even *consider* speaking to unprompted, and where.
 *
 * **Countable, and deliberately outside the prompt.** Speaking first is the one
 * thing this agent does that nobody asked for, so what stops it being a nuisance
 * must not be a paragraph a model can reason its way around. The step is handed
 * a list that has already been filtered; it is never asked whether now is a
 * reasonable time to interrupt somebody.
 *
 * Same rule as everywhere else here: mention detection is code, standing is
 * code, the verdict is code. A model that can talk itself into speaking will.
 */

/** A channel to post in, or a person to message directly. */
export type TargetKind = "channel" | "dm";

export interface InitiativeTarget {
  /**
   * What the model returns: `channel:C07ABC` or `dm:U123`.
   *
   * Prefixed because a channel id and an identity id are both opaque strings
   * and nothing else would tell them apart — and the harness has to know which
   * send path to use.
   */
  ref: string;
  kind: TargetKind;
  id: string;
  /** What to call them, or it: `#deploys`, or a person's display name. */
  name: string;
  /** Milliseconds since anybody said anything here. Infinity when never. */
  silentMs: number;
  agentHasSpoken: boolean;
  messagesSinceAgentSpoke: number;
  /** DM only: what is known about this person, so the step can weigh it. */
  summary?: string;
}

export const channelRef = (id: string): string => `channel:${id}`;
export const dmRef = (identityId: string): string => `dm:${identityId}`;

export interface InitiativeGate {
  /** Targets it may be offered. Empty means do not ask at all. */
  eligible: InitiativeTarget[];
  /** Why nothing is eligible, for the log. Absent when something is. */
  blocked?: string;
}

export interface GateInput {
  config: Config;
  channels: readonly ChannelSurvey[];
  /** Everybody on file. Filtered here, not by the caller. */
  identities?: readonly Identity[];
  /** Identity id -> how many impressions exist for them. */
  impressionCounts?: ReadonlyMap<string, number>;
  /** When the agent last started anything, anywhere. */
  lastInitiatedAt?: string | undefined;
  /** Target ref -> when the agent last started something with *that* target. */
  lastPerTarget?: ReadonlyMap<string, string>;
  now?: number;
}

export function eligibleTargets(input: GateInput): InitiativeGate {
  const {
    enabled,
    free_after_ms,
    recent_after_ms,
    max_silent_ms,
    cooldown_ms,
    target_cooldown_ms,
    require_history,
    dm_enabled,
    dm_stale_ms,
  } = input.config.session.initiative;
  if (!enabled) return { eligible: [], blocked: "initiative is off" };

  const now = input.now ?? Date.now();

  // **One conversation started per cooldown, across every target.** Per-target
  // alone would let an agent with six rooms and four contacts open ten at once,
  // each locally reasonable — the failure weighted participation exists to damp,
  // one level up.
  if (input.lastInitiatedAt) {
    const since = now - new Date(input.lastInitiatedAt).getTime();
    if (since < cooldown_ms) {
      return {
        eligible: [],
        blocked: `${Math.round((cooldown_ms - since) / 1000)}s of cooldown left`,
      };
    }
  }

  /** Long gap before going back to the *same* target, on top of the global one. */
  const recentlyUsed = (ref: string): boolean => {
    const at = input.lastPerTarget?.get(ref);
    return at !== undefined && now - new Date(at).getTime() < target_cooldown_ms;
  };

  const eligible: InitiativeTarget[] = [];

  for (const c of input.channels) {
    // **Quiet for too long is a no**, and this is the guard easy to leave out:
    // the survey sorts by silence, so without an upper bound the deadest channel
    // on record is permanently the most eligible one.
    if (c.silentMs > max_silent_ms) continue;

    if (require_history && (!c.agentHasSpoken || c.messages === 0)) continue;

    // **A ladder rather than one cutoff**, because how much silence excuses
    // speaking depends on who has been doing the talking. A flat "quiet for an
    // hour" both blocks the agent from picking up a live conversation it has a
    // place in, and lets it monologue into a room where nobody has answered it
    // twice already.
    //
    //   past `free_after_ms`      — a fresh start; even following its own last
    //                               message is fine, because hours have passed
    //   past `recent_after_ms`    — allowed unless it already has the last two,
    //                               since a third would be three in a row
    //   sooner than that          — allowed only if somebody else spoke last
    const allowed =
      c.silentMs > free_after_ms
        ? true
        : c.silentMs > recent_after_ms
          ? c.trailingAgentMessages < 2
          : c.trailingAgentMessages < 1;
    if (!allowed) continue;

    if (recentlyUsed(channelRef(c.id))) continue;

    eligible.push({
      ref: channelRef(c.id),
      kind: "channel",
      id: c.id,
      name: c.name,
      silentMs: c.silentMs,
      agentHasSpoken: c.agentHasSpoken,
      messagesSinceAgentSpoke: c.messagesSinceAgentSpoke,
    });
  }

  if (dm_enabled) {
    for (const person of input.identities ?? []) {
      // **Somebody it has an impression of.** Not merely somebody who has once
      // spoken: an impression means the agent has actually formed a view of
      // them across exchanges, which is the difference between writing to
      // somebody you know and writing to a name in a log.
      if ((input.impressionCounts?.get(person.id) ?? 0) === 0) continue;

      // Gone quiet for good. Without this the least active contact on file is
      // permanently the most eligible, the same trap `max_silent_ms` closes for
      // channels — and messaging somebody who left months ago is worse.
      const seen = person.lastSeenAt ? now - new Date(person.lastSeenAt).getTime() : Infinity;
      if (seen > dm_stale_ms) continue;

      if (recentlyUsed(dmRef(person.id))) continue;

      eligible.push({
        ref: dmRef(person.id),
        kind: "dm",
        id: person.id,
        name: person.displayName,
        silentMs: seen,
        // A DM is between two people; "who spoke last" is a channel question and
        // the reply path already owns it. What matters here is that the agent
        // knows them, which the impression already established.
        agentHasSpoken: true,
        messagesSinceAgentSpoke: 0,
        ...(person.summary.trim() ? { summary: person.summary.trim() } : {}),
      });
    }
  }

  return eligible.length > 0
    ? { eligible }
    : { eligible: [], blocked: "nothing is in the window" };
}
