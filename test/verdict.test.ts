import { describe, expect, it } from "vitest";
import { deriveVerdict, wantsReply } from "../src/steps/verdict.ts";
import { NOTHING, type Reading } from "../src/steps/read.ts";
import { mentionPolicy } from "../src/core/mentionPolicy.ts";
import type { Stance } from "../src/steps/stance.ts";

const MIN = 0.3;

const reading = (over: Partial<Reading> = {}): Reading => ({
  reason: "",
  target: NOTHING,
  addressee: "room",
  wants: "answer",
  ...over,
});
const stance = (interest: number): Stance => ({ reason: "", interest, reaction: "+1" });

const derive = (args: { mentioned?: boolean; reading?: Reading; interest?: number }) =>
  deriveVerdict({
    mentioned: args.mentioned ?? false,
    reading: args.reading ?? reading(),
    stance: stance(args.interest ?? 0.5),
    minInterest: MIN,
  });

describe("deriveVerdict", () => {
  it("answers a question however little the agent has to add", () => {
    // Above the interest test on purpose: letting a low score silence a direct
    // question is the failure mention detection exists to prevent.
    expect(
      derive({ reading: reading({ addressee: "agent", wants: "answer" }), interest: 0 }),
    ).toBe("reply");
  });

  it("answers a question even when the agent was not named", () => {
    expect(derive({ reading: reading({ addressee: "room", wants: "answer" }), interest: 0 })).toBe(
      "reply",
    );
  });

  it("acknowledges a message that is addressed but wants nothing back", () => {
    expect(derive({ reading: reading({ addressee: "agent", wants: "acknowledgement" }) })).toBe(
      "acknowledge",
    );
  });

  it("joins an exchange nothing was asked of, when the agent has something to add", () => {
    // The failure a boolean "was the agent addressed?" produces: somebody
    // sharing a thought correctly produces silence.
    expect(
      derive({ reading: reading({ addressee: "room", wants: "nothing" }), interest: 0.8 }),
    ).toBe("reply");
  });

  it("stays out of somebody else's exchange when it has nothing to add", () => {
    expect(
      derive({ reading: reading({ addressee: "other", wants: "nothing" }), interest: 0 }),
    ).toBe("for_someone_else");
  });

  it("calls a remark to the room with nothing to add a tangent, not somebody else's", () => {
    expect(derive({ reading: reading({ addressee: "room", wants: "nothing" }), interest: 0 })).toBe(
      "tangent",
    );
  });

  // --- The mention loop -----------------------------------------------------
  // Seen live: two instances named each other in messages that asked nothing.
  // Being named forces the probability to 1.0 and takes no draw, so every
  // damping term in the system was disabled by exactly the thing causing the
  // loop, and each forced answer named the other agent again.

  it("marks rather than answers a bare acknowledgement that named the agent", () => {
    expect(
      derive({
        mentioned: true,
        reading: reading({ addressee: "agent", wants: "acknowledgement" }),
        interest: 1,
      }),
    ).toBe("acknowledge");
  });

  it("marks rather than answers a mention in passing it has nothing to add to", () => {
    expect(
      derive({
        mentioned: true,
        reading: reading({ addressee: "room", wants: "nothing" }),
        interest: 0.1,
      }),
    ).toBe("acknowledge");
  });

  it("never leaves a message that named the agent unanswered *and* unmarked", () => {
    // The property mention detection exists to protect, and the one thing that
    // must survive the loop fix: being named always gets one or the other.
    for (const wants of ["answer", "acknowledgement", "nothing"] as const) {
      for (const interest of [0, 0.3, 1]) {
        const verdict = derive({
          mentioned: true,
          reading: reading({ addressee: "agent", wants }),
          interest,
        });
        expect(["reply", "acknowledge"], `${wants} @ ${interest}`).toContain(verdict);
      }
    }
  });

  it("still speaks up when named and it genuinely has a point", () => {
    // Being named must not become a reason to stay quiet. Nothing was asked,
    // but the agent has something worth saying, so it says it.
    expect(
      derive({
        mentioned: true,
        reading: reading({ addressee: "room", wants: "nothing" }),
        interest: 0.9,
      }),
    ).toBe("reply");
  });

  it("treats the reading's own fallback as a reply, so a parse failure is not silence", () => {
    expect(derive({ interest: 0 })).toBe("reply");
  });

  it("derives a written answer from `reply` alone", () => {
    expect(wantsReply("reply")).toBe(true);
    for (const v of ["acknowledge", "for_someone_else", "tangent"] as const) {
      expect(wantsReply(v)).toBe(false);
    }
  });
});

describe("mentionPolicy", () => {
  it("forbids naming anybody when the agent has little to add", () => {
    // The other end of the loop: a reply that names somebody compels a reply.
    const policy = mentionPolicy(0.1, MIN);
    expect(policy.allowed).toBe(false);
    expect(policy.text).toContain("Do not @mention");
  });

  it("permits it when the agent has a real point", () => {
    expect(mentionPolicy(0.9, MIN).allowed).toBe(true);
  });

  it("permits it when interest was never measured", () => {
    // Absent is not zero. Every other fallback on this path leans toward
    // behaving normally, and so does this one.
    expect(mentionPolicy(undefined, MIN).allowed).toBe(true);
  });

  it("treats the threshold itself as enough", () => {
    expect(mentionPolicy(MIN, MIN).allowed).toBe(true);
  });
});
