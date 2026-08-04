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
 * talking against its fair share and pulls the odds down when it is over.
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
  /** The react step's verdict, when one was obtained. */
  modelSaidYes: boolean | undefined;
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

  const followup = input.directFollowup ? config.followup_multiplier : 1;
  const model =
    input.modelSaidYes === undefined
      ? 1
      : input.modelSaidYes
        ? config.model_yes_multiplier
        : config.model_no_multiplier;

  const factors: ParticipationFactors = {
    base: config.base,
    damping,
    followup,
    model,
    participants,
    agentShare,
    fairShare,
  };

  // Being named is not a probability. A direct question that goes unanswered
  // because of a dice roll is a broken assistant, not a well-behaved one.
  if (input.mentioned) {
    return { probability: config.mention, factors, forced: true };
  }

  return {
    probability: clamp(config.base * damping * followup * model, 0, config.max),
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
