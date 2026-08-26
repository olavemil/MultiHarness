import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NOTHING, read, replyTargetKind, type Reading } from "../src/steps/read.ts";
import type { Config } from "../src/config/schema.ts";
import type { BlockInput } from "../src/context/blocks/index.ts";
import type { ChannelMessage } from "../src/core/types.ts";

let seq = 0;
const msg = (author: string, text: string, fromAgent = false): ChannelMessage => ({
  id: `uuid-${seq++}`,
  identityId: fromAgent ? "agent" : author,
  author,
  text,
  at: "2026-08-03T09:14:00.000Z",
  fromAgent,
});

const history: ChannelMessage[] = [
  msg("olav", "what node version does this target?"),
  msg("harness", "Node 22 or newer.", true),
  msg("dana", "I'll bump the CI image"),
];

const reading = (over: Partial<Reading> = {}): Reading => ({
  reason: "",
  target: NOTHING,
  addressee: "room",
  wants: "answer",
  ...over,
});

const schemaFor = (h: readonly ChannelMessage[]) =>
  z.toJSONSchema(read.buildSchema({} as Config, { history: h } as BlockInput)) as {
    properties: Record<string, { enum?: string[] }>;
  };

describe("read", () => {
  it("resolves a local id back to the agent's own turn", () => {
    expect(replyTargetKind(reading({ target: "m2" }), history)).toBe("agent");
  });

  it("resolves a local id back to another participant", () => {
    expect(replyTargetKind(reading({ target: "m3" }), history)).toBe("other");
  });

  it("treats an unresolvable id as nothing rather than guessing", () => {
    expect(replyTargetKind(reading({ target: "m99" }), history)).toBe(NOTHING);
  });

  it("compiles only the ids actually in the window, so an invalid reference is undecodable", () => {
    // Window-local ids, not UUIDs: a small model copying a UUID accurately is a
    // self-inflicted failure, and at ~20 tokens each they would eat the budget.
    expect(schemaFor(history).properties["target"]?.enum).toEqual([NOTHING, "m1", "m2", "m3"]);
  });

  it("still offers `nothing` when the channel has no history at all", () => {
    // The enum must stay non-empty for constrained decoding, and a first message
    // in a channel genuinely replies to nothing.
    expect(schemaFor([]).properties["target"]?.enum).toEqual([NOTHING]);
  });

  it("decodes the reason before the three facts it justifies", () => {
    // Constrained decoding emits keys in schema order. Putting the reasoning
    // field before the field it justifies is chain-of-thought inside the
    // structured output, and it took the old `react` from 9/10 to 10/10 when
    // three prompt rewrites could not move it.
    expect(Object.keys(schemaFor(history).properties)).toEqual([
      "reason",
      "target",
      "addressee",
      "wants",
    ]);
  });

  it("falls back to a reply with no target, never to an invented link", () => {
    const fallback = read.fallback({} as Config);
    expect(fallback.target).toBe(NOTHING);
    expect(fallback.wants).toBe("answer");
  });
});
