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

  it("lands on the base rate at fair share in a two-person channel", () => {
    // The property that keeps DMs working with no special case: two
    // participants, an alternating agent, damping 1.0 and crowd 1.0.
    const history = transcript(12, 6, 1);
    const result = responseProbability(
      { history, mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.factors.participants).toBe(2);
    expect(result.factors.damping).toBeCloseTo(1, 1);
    expect(result.factors.crowd).toBe(1);
    expect(result.probability).toBeCloseTo(config.base, 1);
  });

  it("damps by room size even when the agent is at fair share", () => {
    // Deliberate change. Presence damping is 1.0 here, so before the crowd term
    // this returned the full base rate in a room of any size.
    const result = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.factors.participants).toBe(3);
    expect(result.factors.damping).toBeCloseTo(1, 1);
    expect(result.factors.crowd).toBeCloseTo(2 / 3, 2);
    expect(result.probability).toBeLessThan(config.base);
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

    // Presence damping is identical — both pinned to the cap.
    expect(large.damping).toBeCloseTo(small.damping, 5);
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

  it("treats a two-person conversation as fair when alternating, with no special case", () => {
    const history = transcript(12, 6, 1);
    const result = responseProbability(
      { history, mentioned: false, directFollowup: false, interest: undefined },
      config,
    );
    expect(result.factors.participants).toBe(2);
    expect(result.factors.damping).toBeCloseTo(1, 1);
  });

  it("raises the odds for a direct followup and for a model yes", () => {
    const base = { history: transcript(12, 4, 2), mentioned: false };
    const plain = p({ ...base, directFollowup: false, interest: undefined });
    expect(p({ ...base, directFollowup: true, interest: undefined })).toBeGreaterThan(plain);
    expect(p({ ...base, directFollowup: false, interest: 1 })).toBeGreaterThan(plain);
  });

  it("halves the odds on a model no without zeroing them", () => {
    const base = { history: transcript(12, 4, 2), mentioned: false, directFollowup: false };
    const no = p({ ...base, interest: 0 });
    const undecided = p({ ...base, interest: undefined });
    expect(no).toBeCloseTo(undecided * config.model_no_multiplier, 5);
    expect(no).toBeGreaterThan(0);
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
    expect(factors).toMatchObject({ base: config.base, followup: 2.5, model: 1.5 });
    expect(factors.agentShare).toBeCloseTo(1 / 3, 2);
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
  // Four people including the agent, which halves the crowd term.
  const room = [msg("olav"), msg("agent", true), msg("galatea"), msg("dana")];

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
