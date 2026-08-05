import type { ChannelMessage } from "./types.ts";
import type { ParticipationConfig } from "../config/schema.ts";

/**
 * Weighted participation: how likely the agent should be to speak, given where
 * it sits in the conversation.
 *
 * This exists to damp a failure mode no per-message judgement can see. Each
 * individual reply looks locally justified, so an agent that answers everything
 * it *could* answer ends up dominating a channel while never making an
 * obviously wrong call. Presence damping compares how much the agent has been
 * talking against its fair share and pulls the odds down when it is over; a
 * separate crowd term pulls them down as the room grows, which presence damping
 * does not do on its own.
 *
 * Every factor is reported alongside the result — a hidden RNG driving whether
 * the agent speaks would make "why didn't it answer me?" unanswerable and put
 * prompt changes below the noise floor.
 */

export interface ParticipationFactors {
  base: number;
  /** Presence damping: 1.0 at fair share, below 1 when over-talking. */
  damping: number;
  followup: number;
  model: number;
  /** Damping by room size, independent of how much the agent has said. */
  crowd: number;
  /** Distinct identities seen in the participant window, agent included. */
  participants: number;
  /** Agent's share of the presence window. */
  agentShare: number;
  fairShare: number;
}

export interface Participation {
  probability: number;
  factors: ParticipationFactors;
  /** True when the agent was named — probability is forced, nothing is drawn. */
  forced: boolean;
}

export interface ParticipationInput {
  history: readonly ChannelMessage[];
  /** The agent was named. Short-circuits everything else. */
  mentioned: boolean;
  /** The agent's own message is the one immediately before this. */
  directFollowup: boolean;
  /**
   * How much the agent has to add, 0 to 1, from `react`. Absent when the
   * step did not run — being named skips it.
   */
  interest: number | undefined;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export function responseProbability(
  input: ParticipationInput,
  config: ParticipationConfig,
): Participation {
  const participants = countParticipants(input.history, config.participant_window);
  const agentShare = shareOfWindow(input.history, config.presence_window);
  const fairShare = 1 / Math.max(participants, 1);

  // 1.0 at fair share; below 1 when the agent is talking more than its share.
  // At two participants an alternating agent sits at ~0.5 share against a 0.5
  // fair share, so this lands on 1.0 with no special case for DMs.
  const damping = clamp(
    fairShare / Math.max(agentShare, 1e-6),
    config.damping_min,
    config.damping_max,
  );

  // Presence damping alone does not damp crowding, which is the thing it looks
  // like it should do. `fairShare / agentShare` pins to the cap whenever the
  // agent has said little, so a near-silent agent in a ten-person room is
  // exactly as ready to speak as in a three-person one — and "comments on
  // everyone else's single message" is precisely the failure in a busy room.
  //
  // This term depends on room size only. Two participants gives 1.0, so a DM
  // is unaffected and still needs no special case.
  const crowd = clamp(2 / Math.max(participants, 2), config.crowd_min, 1);

  const followup = input.directFollowup ? config.followup_multiplier : 1;
  // Interpolated between the two multipliers rather than switched between them.
  // A boolean threw away everything the step knew: "barely worth saying" and
  // "I have a real point here" both arrived as `true`.
  const model =
    input.interest === undefined
      ? 1
      : config.model_no_multiplier +
        clamp(input.interest, 0, 1) * (config.model_yes_multiplier - config.model_no_multiplier);

  const factors: ParticipationFactors = {
    base: config.base,
    damping,
    crowd,
    followup,
    model,
    participants,
    agentShare,
    fairShare,
  };

  // Being named is not a probability. A direct question that goes unanswered
  // because of a dice roll is a broken agent, not a well-behaved one.
  if (input.mentioned) {
    return { probability: config.mention, factors, forced: true };
  }

  return {
    probability: clamp(config.base * damping * crowd * followup * model, 0, config.max),
    factors,
    forced: false,
  };
}

/** Draws against the probability. `rng` is injectable so sessions are replayable. */
export function drawParticipation(
  participation: Participation,
  rng: () => number = Math.random,
): { speak: boolean; draw: number } {
  if (participation.forced) return { speak: true, draw: 0 };
  const draw = rng();
  return { speak: draw < participation.probability, draw };
}

function countParticipants(history: readonly ChannelMessage[], window: number): number {
  const seen = new Set<string>();
  for (const message of history.slice(-window)) seen.add(message.identityId);
  // The agent counts as a participant even when it has not spoken yet.
  seen.add("agent");
  return seen.size;
}

function shareOfWindow(history: readonly ChannelMessage[], window: number): number {
  const recent = history.slice(-window);
  if (recent.length === 0) return 0;
  return recent.filter((message) => message.fromAgent).length / recent.length;
}

export interface InterjectInput {
  /** The agent was named. A direct address is never held back. */
  mentioned: boolean;
  /** Messages still queued for this channel behind the one being handled. */
  queued: number;
  /** Injectable so a session is replayable. */
  rng?: (() => number) | undefined;
}

/**
 * How long to wait before working on a message nobody addressed.
 *
 * Several agents in one room otherwise race: each decides independently and as
 * fast as it can, so both answer before either can see the other. Waiting gives
 * anyone else — sibling instance or human, and the agent does not need to know
 * which — the chance to answer first. History is read after the wait, so `react`
 * simply sees that the question has been dealt with and declines. No new
 * judgement, no coordination channel, and nothing that treats an agent
 * differently from a person.
 *
 * **Jittered**, because two instances configured identically would otherwise
 * wake at the same moment and race exactly as before.
 *
 * Skipped when messages are queued behind this one: the wait exists to let
 * someone else speak, and someone else already has.
 */
export function interjectDelay(config: ParticipationConfig, input: InterjectInput): number {
  if (input.mentioned) return 0;
  if (input.queued > 0) return 0;
  if (config.interject_delay_ms <= 0) return 0;

  const rng = input.rng ?? Math.random;
  return Math.round(config.interject_delay_ms * (0.5 + rng()));
}
