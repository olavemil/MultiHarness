import { describe, expect, it } from "vitest";
import { normaliseEmoji } from "../src/core/emoji.ts";

describe("normaliseEmoji", () => {
  it("accepts a bare name", () => {
    expect(normaliseEmoji("eyes")).toBe("eyes");
  });

  it("strips the colons models write about half the time", () => {
    expect(normaliseEmoji(":eyes:")).toBe("eyes");
    expect(normaliseEmoji("  :white_check_mark:  ")).toBe("white_check_mark");
  });

  it("lowercases, so a capitalised guess still lands", () => {
    expect(normaliseEmoji("Eyes")).toBe("eyes");
  });

  it("keeps the punctuation Slack names actually use", () => {
    expect(normaliseEmoji("+1")).toBe("+1");
    expect(normaliseEmoji("-1")).toBe("-1");
    expect(normaliseEmoji("e-mail")).toBe("e-mail");
  });

  it("passes through a name nothing may recognise", () => {
    // The whole point of dropping the enum: whether an emoji exists is Slack's
    // answer to give, not a list's. A wrong guess costs a log line.
    expect(normaliseEmoji("party_parrot")).toBe("party_parrot");
  });

  it("refuses what could not be an emoji name at all", () => {
    // Refused rather than sent, because the adapter would turn each of these
    // into an API call that could only fail.
    expect(normaliseEmoji("")).toBeUndefined();
    expect(normaliseEmoji("  ")).toBeUndefined();
    expect(normaliseEmoji("a thumbs up please")).toBeUndefined();
    expect(normaliseEmoji("👍")).toBeUndefined();
    expect(normaliseEmoji(undefined)).toBeUndefined();
  });
});
