import { describe, expect, it } from "vitest";
import { resolveReactionName } from "../src/adapters/slack/reactionResolver.ts";

describe("slack reaction resolution", () => {
  it("keeps an exact match", () => {
    const resolved = resolveReactionName("thumbsup", ["thumbsup", "eyes"]);
    expect(resolved).toEqual({ kind: "exact", emoji: "thumbsup" });
  });

  it("returns one fuzzy match when it is clearly best", () => {
    const resolved = resolveReactionName("thmbsup", ["thumbsup", "eyes", "tada"]);
    expect(resolved.kind).toBe("fuzzy");
    if (resolved.kind === "fuzzy") {
      expect(resolved.emoji).toBe("thumbsup");
      expect(resolved.score).toBeGreaterThan(0.82);
    }
  });

  it("returns ambiguous when several candidates match similarly", () => {
    const resolved = resolveReactionName("thumbsa", ["thumbsb", "thumbsc", "thumbsdown"]);
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind === "ambiguous") {
      expect(resolved.candidates.length).toBeGreaterThan(1);
      expect(resolved.candidates).toContain("thumbsb");
      expect(resolved.candidates).toContain("thumbsc");
    }
  });

  it("reports unverified when no catalog is available", () => {
    const resolved = resolveReactionName("eyes", []);
    expect(resolved).toEqual({ kind: "unverified", emoji: "eyes" });
  });
});
