import { describe, expect, it } from "vitest";
import { ParticipationConfig } from "../src/config/schema.ts";
import { drawParticipation, responseProbability } from "../src/core/participation.ts";
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
      { history: transcript(12, 11, 2), mentioned: true, directFollowup: false, modelSaidYes: false },
      config,
    );
    expect(result.probability).toBe(1);
    expect(result.forced).toBe(true);
  });

  it("lands on the base rate at fair share", () => {
    // 3 participants, agent holds a third of the window.
    const history = transcript(12, 4, 2);
    const result = responseProbability(
      { history, mentioned: false, directFollowup: false, modelSaidYes: undefined },
      config,
    );
    expect(result.factors.participants).toBe(3);
    expect(result.factors.damping).toBeCloseTo(1, 1);
    expect(result.probability).toBeCloseTo(config.base, 1);
  });

  it("damps an agent that is talking more than its share", () => {
    const hogging = p({ history: transcript(12, 9, 2), mentioned: false, directFollowup: false, modelSaidYes: undefined });
    const fair = p({ history: transcript(12, 4, 2), mentioned: false, directFollowup: false, modelSaidYes: undefined });
    expect(hogging).toBeLessThan(fair);
  });

  it("lifts an agent that has been quiet", () => {
    const quiet = p({ history: transcript(12, 0, 2), mentioned: false, directFollowup: false, modelSaidYes: undefined });
    const fair = p({ history: transcript(12, 4, 2), mentioned: false, directFollowup: false, modelSaidYes: undefined });
    expect(quiet).toBeGreaterThan(fair);
  });

  it("treats a two-person conversation as fair when alternating, with no special case", () => {
    const history = transcript(12, 6, 1);
    const result = responseProbability(
      { history, mentioned: false, directFollowup: false, modelSaidYes: undefined },
      config,
    );
    expect(result.factors.participants).toBe(2);
    expect(result.factors.damping).toBeCloseTo(1, 1);
  });

  it("raises the odds for a direct followup and for a model yes", () => {
    const base = { history: transcript(12, 4, 2), mentioned: false };
    const plain = p({ ...base, directFollowup: false, modelSaidYes: undefined });
    expect(p({ ...base, directFollowup: true, modelSaidYes: undefined })).toBeGreaterThan(plain);
    expect(p({ ...base, directFollowup: false, modelSaidYes: true })).toBeGreaterThan(plain);
  });

  it("halves the odds on a model no without zeroing them", () => {
    const base = { history: transcript(12, 4, 2), mentioned: false, directFollowup: false };
    const no = p({ ...base, modelSaidYes: false });
    const undecided = p({ ...base, modelSaidYes: undefined });
    expect(no).toBeCloseTo(undecided * config.model_no_multiplier, 5);
    expect(no).toBeGreaterThan(0);
  });

  it("never exceeds the configured maximum", () => {
    const result = responseProbability(
      { history: transcript(12, 0, 3), mentioned: false, directFollowup: true, modelSaidYes: true },
      config,
    );
    expect(result.probability).toBeLessThanOrEqual(config.max);
  });

  it("reports every factor, so a decision can be explained after the fact", () => {
    const { factors } = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: true, modelSaidYes: true },
      config,
    );
    expect(factors).toMatchObject({ base: config.base, followup: 2.5, model: 1.5 });
    expect(factors.agentShare).toBeCloseTo(1 / 3, 2);
  });
});

describe("drawParticipation", () => {
  it("does not draw at all when the reply is forced", () => {
    const forced = responseProbability(
      { history: [], mentioned: true, directFollowup: false, modelSaidYes: false },
      config,
    );
    expect(drawParticipation(forced, () => 0.99)).toEqual({ speak: true, draw: 0 });
  });

  it("speaks only when the draw falls under the probability", () => {
    const decision = responseProbability(
      { history: transcript(12, 4, 2), mentioned: false, directFollowup: false, modelSaidYes: undefined },
      config,
    );
    expect(drawParticipation(decision, () => 0).speak).toBe(true);
    expect(drawParticipation(decision, () => 0.999).speak).toBe(false);
  });
});
