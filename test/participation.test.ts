import { describe, expect, it } from "vitest";
import { ParticipationConfig } from "../src/config/schema.ts";
import {
  drawParticipation,
  interjectDelay,
  responseProbability,
} from "../src/core/participation.ts";
import type { ChannelMessage } from "../src/core/types.ts";

const config = ParticipationConfig.parse({});

let seq = 0;
const msg = (identityId: string, fromAgent = false): ChannelMessage => ({
  id: `m${seq++}`,
  identityId,
  author: identityId,
  text: "…",
  at: "2026-08-03T20:00:00.000Z",
  fromAgent,
});

/** `agentOf` messages from the agent, the rest split between `others` people. */
const transcript = (total: number, agentOf: number, others: number): ChannelMessage[] => {
  const out: ChannelMessage[] = [];
  for (let i = 0; i < total; i++) {
    out.push(i < agentOf ? msg("agent", true) : msg(`p${i % others}`));
  }
  return out;
};

const p = (input: Parameters<typeof responseProbability>[0]) =>
  responseProbability(input, config).probability;

describe("responseProbability", () => {
  it("forces a reply when the agent was named, whatever the damping says", () => {
    const result = responseProbability(
      { history: transcript(12, 11, 2), mentioned: true, directFollowup: false, interest: 0 },
      config,
    );
    expect(result.probability).toBe(1);
    expect(result.forced).toBe(true);
  });

  it("expects the other party to carry a two-person conversation", () => {
    // Fair share is of *replies*, not of messages: nobody answers their own
    // message, so the share is split among everyone else. With two people the
    // other party owes 100% of the answers, so an agent alternating at 50% is
    // at *half* its share and the damping lifts it rather than sitting neutral.
    const history = transcript(12, 6, 1);
    const result = responseProbability(
      { history, mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.factors.participants).toBe(2);
    expect(result.factors.fairShare).toBe(1);
    // Half its fair share of replies, so damping sits above the 0.5 midpoint.
    expect(result.factors.damping).toBeGreaterThan(0.5);
    expect(result.factors.damping).toBeLessThanOrEqual(1);
    expect(result.factors.crowd).toBe(1);
    // `base` is the ceiling now — every weight is 0..1 — so the assertion is
    // that a two-person channel beats a crowded one, not that it beats `base`.
    const crowded = responseProbability(
      { history: transcript(12, 6, 5), mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.probability).toBeGreaterThan(crowded.probability);
    expect(result.probability).toBeLessThanOrEqual(config.base);
  });

  it("replies half the time when every measurement sits at its midpoint", () => {
    // The calibration the whole scheme is built on, and the sentence to check a
    // change against: everything average means a coin flip. Four participants
    // puts `crowd` at 0.5, an agent holding exactly its fair share of replies
    // puts `damping` at 0.5, and interest 0.5 maps straight through.
    const result = responseProbability(
      { history: transcript(12, 4, 3), mentioned: false, directFollowup: false, interest: 0.5 },
      config,
    );

    expect(result.factors.participants).toBe(4);
    expect(result.factors.damping).toBeCloseTo(0.5, 6);
    expect(result.factors.crowd).toBeCloseTo(0.5, 6);
    expect(result.factors.model).toBeCloseTo(0.5, 6);
    expect(result.probability).toBeCloseTo(0.5, 6);
  });

  it("moves off that midpoint in the direction of each signal", () => {
    const at = (over: Partial<Parameters<typeof responseProbability>[0]>) =>
      responseProbability(
        {
          history: transcript(12, 4, 3),
          mentioned: false,
          directFollowup: false,
          interest: 0.5,
          ...over,
        },
        config,
      ).probability;

    const midpoint = at({});
    // Talking more than its share pulls it down; interest pulls it up.
    expect(at({ history: transcript(12, 9, 3) })).toBeLessThan(midpoint);
    expect(at({ interest: 1 })).toBeGreaterThan(midpoint);
    expect(at({ interest: 0 })).toBeLessThan(midpoint);
    expect(at({ directFollowup: true })).toBeGreaterThan(midpoint);
    expect(at({ ownSubject: true })).toBeCloseTo(midpoint * 2, 6);
  });

  it("gives exactly the base rate when every coefficient is neutral", () => {
    // The average seeds at 0, so `base` means what it says. It used to seed at
    // 1, which added ~20% invisibly and put the real floor somewhere the config
    // did not mention.
    // Every weight at its top: silent agent, empty room, interest 1.
    const neutral = responseProbability(
      { history: [], mentioned: false, directFollowup: false, interest: 1 },
      { ...config, damping_min: 1 },
    );
    expect(neutral.factors.averaged).toBeCloseTo(1, 6);
    expect(neutral.probability).toBeCloseTo(config.base, 6);
  });

  it("damps by room size even when the agent is at fair share", () => {
    // The crowd term depends on room size alone. It no longer drives the
    // probability under the base rate on its own — averaging is what stops any
    // single coefficient dominating — so the assertion is against a smaller
    // room rather than against `base`.
    const result = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    const dm = responseProbability(
      { history: transcript(12, 6, 1), mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.factors.participants).toBe(3);
    expect(result.factors.crowd).toBeCloseTo(2 / 3, 2);
    expect(result.probability).toBeLessThan(dm.probability);
  });

  it("damps a quiet agent as the room grows, which presence damping does not", () => {
    // The failure this term exists for. `fairShare / agentShare` pins to the
    // cap whenever the agent has said little, so without it a near-silent agent
    // in a ten-person room is exactly as ready to speak as in a three-person
    // one — and "comments on everyone else's message" is a crowded-room
    // problem.
    const quietIn = (participants: number) => {
      const result = responseProbability(
        {
          history: transcript(12, 0, participants - 1),
          mentioned: false,
          directFollowup: false,
          interest: undefined,
        },
        config,
      );
      return { p: result.probability, damping: result.factors.damping };
    };

    const small = quietIn(3);
    const large = quietIn(10);

    // Presence damping is effectively identical: a silent agent sits at the top
    // of its range whatever the room size, which is precisely why it cannot be
    // the term that answers "is this room crowded?".
    expect(large.damping).toBeCloseTo(small.damping, 3);
    expect(small.damping).toBeCloseTo(1, 3);
    // The probability is not.
    expect(large.p).toBeLessThan(small.p);
  });

  it("damps an agent that is talking more than its share", () => {
    const hogging = p({ history: transcript(12, 9, 2), mentioned: false, directFollowup: false, interest: undefined });
    const fair = p({ history: transcript(12, 4, 2), mentioned: false, directFollowup: false, interest: undefined });
    expect(hogging).toBeLessThan(fair);
  });

  it("lifts an agent that has been quiet", () => {
    const quiet = p({ history: transcript(12, 0, 2), mentioned: false, directFollowup: false, interest: undefined });
    const fair = p({ history: transcript(12, 4, 2), mentioned: false, directFollowup: false, interest: undefined });
    expect(quiet).toBeGreaterThan(fair);
  });

  it("keeps one low coefficient from dominating the rest", () => {
    // The failure that motivated averaging: multiplied, `crowd` alone capped a
    // six-person room at 0.33 whatever else was true, so agents answered only
    // when named. Averaged, a strong signal still lifts a crowded room.
    const crowded = transcript(12, 0, 5);
    const dull = responseProbability(
      { history: crowded, mentioned: false, directFollowup: false, interest: 0 },
      config,
    );
    const keen = responseProbability(
      { history: crowded, mentioned: false, directFollowup: true, interest: 1 },
      config,
    );
    expect(keen.factors.crowd).toBeLessThan(0.5);
    // Multiplied, `crowd` alone would have capped this at 0.33 of base whatever
    // else was true. Averaged, the strong signals still carry it well past the
    // dull case even though the room is against it.
    expect(keen.probability).toBeGreaterThan(dull.probability * 1.3);
    expect(keen.factors.averaged).toBeGreaterThan(0.8);
  });

  it("raises the odds for a direct followup and for a model yes", () => {
    const base = { history: transcript(12, 4, 2), mentioned: false };
    const plain = p({ ...base, directFollowup: false, interest: undefined });
    expect(p({ ...base, directFollowup: true, interest: undefined })).toBeGreaterThan(plain);
    expect(p({ ...base, directFollowup: false, interest: 1 })).toBeGreaterThan(plain);
  });

  it("lowers the odds on a model no without zeroing them", () => {
    // No longer a halving: `model_no_weight` is averaged with the room
    // terms rather than multiplied through, so it pulls the result down without
    // being able to dominate it. The property that matters is unchanged — a
    // model "no" damps the odds and never silences the agent outright.
    const history = transcript(12, 4, 2);
    const shared = { history, mentioned: false, directFollowup: false } as const;
    const no = p({ ...shared, interest: 0 });
    const neutral = p({ ...shared, interest: undefined });
    const yes = p({ ...shared, interest: 1 });

    expect(no).toBeGreaterThan(0);
    expect(no).toBeLessThan(neutral);
    expect(yes).toBeGreaterThan(neutral);
  });

  it("never exceeds the configured maximum", () => {
    const result = responseProbability(
      { history: transcript(12, 0, 3), mentioned: false, directFollowup: true, interest: 1 },
      config,
    );
    expect(result.probability).toBeLessThanOrEqual(config.max);
  });

  it("reports every factor, so a decision can be explained after the fact", () => {
    const { factors } = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: true, interest: 1 },
      config,
    );
    // Everything the probability was built from, including the coefficient that
    // was actually applied — a decision has to be explainable without anyone
    // recomputing the formula from the factors by hand.
    expect(factors).toMatchObject({
      base: config.base,
      followup: config.followup_weight,
      model: config.model_yes_weight,
    });
    expect(factors.agentShare).toBeCloseTo(1 / 3, 2);
    expect(factors.averaged).toBeGreaterThan(0);
    expect(factors.damping).toBeLessThanOrEqual(1);
    expect(factors.crowd).toBeLessThanOrEqual(1);
  });
});

describe("drawParticipation", () => {
  it("does not draw at all when the reply is forced", () => {
    const forced = responseProbability(
      { history: [], mentioned: true, directFollowup: false, interest: 0 },
      config,
    );
    expect(drawParticipation(forced, () => 0.99)).toEqual({ speak: true, draw: 0 });
  });

  it("speaks only when the draw falls under the probability", () => {
    const decision = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(drawParticipation(decision, () => 0).speak).toBe(true);
    expect(drawParticipation(decision, () => 0.999).speak).toBe(false);
  });
});

describe("interjectDelay", () => {
  /**
   * Several agents in one room otherwise race: each decides independently and
   * as fast as it can, so both answer before either can see the other. Waiting
   * lets anyone else answer first — sibling or human, and the agent never needs
   * to know which.
   */
  it("never delays a message that named the agent", () => {
    expect(interjectDelay(config, { mentioned: true, queued: 0, rng: () => 0.5 })).toBe(0);
  });

  it("waits, jittered, on a message nobody addressed", () => {
    const at = (draw: number) =>
      interjectDelay(config, { mentioned: false, queued: 0, rng: () => draw });

    // ±50% around the configured pause. Two instances with identical config
    // would otherwise wake at the same moment and race exactly as before.
    expect(at(0)).toBe(Math.round(config.interject_delay_ms * 0.5));
    expect(at(1)).toBe(Math.round(config.interject_delay_ms * 1.5));
    expect(at(0)).not.toBe(at(1));
  });

  it("does not wait when messages are queued behind this one", () => {
    // The pause exists to let somebody else speak, and somebody else already
    // has — waiting again would only add latency.
    expect(interjectDelay(config, { mentioned: false, queued: 2, rng: () => 0.5 })).toBe(0);
  });

  it("is disabled by a zero delay", () => {
    const off = { ...config, interject_delay_ms: 0 };
    expect(interjectDelay(off, { mentioned: false, queued: 0, rng: () => 0.5 })).toBe(0);
  });
});

describe("standing raises the odds", () => {
  // A four-person channel halves every probability through the crowd term,
  // which is right for chatter and wrong for the thread the agent is in. The
  // same measurement that routes `react` to its own-subject fragment is reused
  // here, so having standing makes the agent likelier to take part rather than
  // only likelier to judge that it could.
  // A crowded room with a talkative agent, so doubling has headroom below the
  // cap and the assertion is about the multiplier rather than about clamping.
  const room = transcript(12, 8, 5);

  it("doubles the probability on the agent's own subject", () => {
    const off = responseProbability(
      { history: room, mentioned: false, directFollowup: false, interest: 0.5 },
      config,
    );
    const on = responseProbability(
      { history: room, mentioned: false, directFollowup: false, ownSubject: true, interest: 0.5 },
      config,
    );

    expect(on.factors.ownSubject).toBe(2);
    expect(off.factors.ownSubject).toBe(1);
    expect(on.probability).toBeCloseTo(off.probability * 2, 6);
  });

  it("leaves it alone when standing was not measured", () => {
    // Undefined means the embed model was unreachable, the feature is off, or
    // the agent has said nothing here. None of those is evidence of absence,
    // and treating them as `false` would silently damp every channel.
    const absent = responseProbability(
      { history: room, mentioned: false, directFollowup: false, interest: 0.5 },
      config,
    );
    const measuredFalse = responseProbability(
      { history: room, mentioned: false, directFollowup: false, ownSubject: false, interest: 0.5 },
      config,
    );
    expect(absent.probability).toBeCloseTo(measuredFalse.probability, 6);
  });

  it("never turns a draw into a certainty beyond the cap", () => {
    // Positional and topical stack, so a follow-up on the agent's own subject
    // saturates rather than running away.
    const both = responseProbability(
      { history: room, mentioned: false, directFollowup: true, ownSubject: true, interest: 1 },
      config,
    );
    expect(both.probability).toBeLessThanOrEqual(1);
    expect(both.probability).toBeGreaterThan(
      responseProbability(
        { history: room, mentioned: false, directFollowup: true, ownSubject: false, interest: 1 },
        config,
      ).probability,
    );
  });
});
