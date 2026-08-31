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
  /** Pseudo-observations of 1.0 added by a direct follow-up; 0 when there was none. */
  followup: number;
  /** The combined coefficient actually applied, before `ownSubject`. */
  averaged: number;
  /** Raised when the message continues a subject the agent itself raised. */
  ownSubject: number;
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
   * Whether this message continues a subject the agent has spoken on, from
   * `core/standing.ts`. Undefined when it was not measured — the feature is
   * off, the agent has said nothing here, or the embed model was unreachable —
   * and undefined must not read as `false`.
   */
  ownSubject?: boolean | undefined;
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
  const fairShare = 1 / Math.max(participants - 1, 1);

  // Fair share of *replies*, not of messages: the sender is not a candidate to
  // answer their own message, so the share is split among the others. In a
  // two-person conversation the other participant owes 100% of the answers,
  // not 50% — which is why this divides by `participants - 1`.
  //
  // 1.0 at fair share; below 1 when the agent is talking more than its share.
  // `fairShare / agentShare` is unbounded above, which broke the one assumption
  // the rest of this function rests on: every weight lives in 0..1, so the
  // average is a blend and the follow-up pull can only ever raise it. A ratio
  // that reaches 2.0 made a follow-up *lower* the odds for an already-eager
  // agent.
  //
  // This form stays in range and keeps the gradient a clamp would flatten:
  // 1.0 when the agent has said nothing, 0.5 at exactly its fair share, and
  // toward 0 as it talks past it.
  const damping = clamp(
    fairShare / (fairShare + Math.max(agentShare, 1e-6)),
    config.damping_min,
    1,
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

  const ownSubject = input.ownSubject === true ? config.own_subject_weight : 0;
  // Interpolated between the two multipliers rather than switched between them.
  // A boolean threw away everything the step knew: "barely worth saying" and
  // "I have a real point here" both arrived as `true`.
  // Unmeasured sits at the midpoint, not at 1. With `model_yes_weight` capped
  // into range, a maximally interested message and one whose interest was never
  // measured both scored 1.0 — so the field could only ever lower the odds, and
  // a step that did not run looked as good as a step that came back certain.
  const model =
    input.interest === undefined
      ? (config.model_no_weight + config.model_yes_weight) / 2
      : config.model_no_weight +
        clamp(input.interest, 0, 1) * (config.model_yes_weight - config.model_no_weight);



  // **Averaged, not multiplied.** A product lets one low coefficient drag the
  // result below every individual term: with four participants `crowd` alone
  // held the ceiling at 0.25, so agents answered only when named. Averaging
  // puts the result between its inputs instead, which is the stable shape.
  const shape = [damping, crowd, model];
  const sum = shape.reduce((a, b) => a + b, 0);

  // **A direct follow-up pulls toward neutral rather than scaling.** It enters
  // as `followup_weight` pseudo-observations of 1.0, so the coefficient moves
  // toward 1 and can never be pushed past it however large the weight.
  //
  // The point is rescue, not reward: somebody has just spoken to the agent, so
  // the room terms that were suppressing it should stop mattering so much. A
  // crowded channel with a hogging agent sits at 0.36 and a follow-up lifts it
  // to 0.65; the same pull *lowers* a coefficient that was already above 1,
  // which is the deliberate half — "you were just addressed" is a reason to
  // ignore damping, not a reason to compound an already-eager agent.
  const followup = input.directFollowup ? config.followup_weight : 0;
  const averaged = (sum + followup + ownSubject) / (shape.length + followup + ownSubject);

  const factors: ParticipationFactors = {
    base: config.base,
    damping,
    crowd,
    followup,
    averaged,
    ownSubject,
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
    probability: clamp(averaged, 0, config.max),
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
