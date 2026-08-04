import { describe, expect, it } from "vitest";
import { detectMention } from "../src/core/mentions.ts";

const agent = { name: "harness", aliases: ["@harness", "hb"] };

describe("detectMention", () => {
  it("matches the bare name and the @ form interchangeably", () => {
    expect(detectMention("harness, what version?", agent)).toBe("harness");
    expect(detectMention("@harness what version?", agent)).toBe("harness");
    expect(detectMention("hey @harness", agent)).toBe("harness");
  });

  it("matches an alias", () => {
    expect(detectMention("hb can you check this", agent)).toBe("hb");
  });

  it("ignores case", () => {
    expect(detectMention("Harness, hello", agent)).toBe("harness");
    expect(detectMention("HARNESS!", agent)).toBe("harness");
  });

  it("does not match a name embedded in a longer word", () => {
    expect(detectMention("the multiharness repo is here", agent)).toBeUndefined();
    expect(detectMention("harnessing the model", agent)).toBeUndefined();
  });

  it("does not match somebody else's name", () => {
    expect(detectMention("@dana can you take a look at the deploy?", agent)).toBeUndefined();
    expect(detectMention("dana: I pushed the fix", agent)).toBeUndefined();
  });

  it("returns undefined for an unaddressed message", () => {
    expect(detectMention("does anyone know why the build is slow?", agent)).toBeUndefined();
  });

  it("tolerates regex metacharacters in configured names", () => {
    expect(detectMention("ping c++ please", { name: "c++", aliases: [] })).toBe("c++");
  });
});
