import { describe, expect, it } from "vitest";
import { computeSituation } from "../src/core/situation.ts";
import type { ChannelMessage } from "../src/core/types.ts";

const agent = { name: "harness", aliases: ["@harness"] };

let seq = 0;
const msg = (author: string, text: string, fromAgent = false): ChannelMessage => ({
  id: `m${seq++}`,
  identityId: fromAgent ? "agent" : author,
  author,
  text,
  at: "2026-08-03T20:00:00.000Z",
  fromAgent,
});

describe("computeSituation", () => {
  it("classifies an unaddressed message with no agent history", () => {
    const s = computeSituation("does anyone know why the build is slow?", [], agent);
    expect(s).toMatchObject({ id: "none_absent", distance: "absent", mentionsOther: undefined });
  });

  it("classifies a direct followup to the agent's last message", () => {
    const history = [msg("olav", "what node version?"), msg("harness", "Node 22 or newer.", true)];
    expect(computeSituation("and why that one?", history, agent).id).toBe("none_immediate");
  });

  it("classifies a message after others have spoken since the agent", () => {
    const history = [
      msg("harness", "Node 22 or newer.", true),
      msg("dana", "makes sense"),
      msg("olav", "agreed"),
    ];
    expect(computeSituation("what about the CI image?", history, agent).id).toBe("none_recent");
  });

  it("detects another participant by @handle", () => {
    const s = computeSituation("@dana can you take a look at the deploy?", [], agent);
    expect(s.mentionsOther).toBe("dana");
    expect(s.id).toBe("other_absent");
  });

  it("detects another participant by their name from channel history", () => {
    const history = [msg("dana", "I pushed the fix"), msg("harness", "Nice.", true)];
    const s = computeSituation("dana, did that cover the migration?", history, agent);
    expect(s.mentionsOther).toBe("dana");
    expect(s.id).toBe("other_immediate");
  });

  it("does not mistake the agent's own name for another participant", () => {
    const history = [msg("harness", "Node 22.", true)];
    const s = computeSituation("thanks harness", history, agent);
    expect(s.mentionsOther).toBeUndefined();
  });

  it("recognises a bare name that was introduced as an @handle earlier", () => {
    // Dana has been addressed in this channel but has never spoken here, so she
    // is not among the authors. A later bare `dana` still refers to a person.
    const history = [msg("olav", "@dana can you take a look at the deploy?")];
    const s = computeSituation("do you think dana would agree with that?", history, agent);
    expect(s.mentionsOther).toBe("dana");
  });

  it("treats an unknown @handle as addressing someone else", () => {
    // Nobody named `ops` has spoken, but the handle still means "not for you".
    expect(computeSituation("@ops please restart it", [], agent).mentionsOther).toBe("ops");
  });

  it("only looks back as far as the window", () => {
    const history = [msg("harness", "old message", true), ...Array.from({ length: 9 }, () => msg("dana", "chatter"))];
    expect(computeSituation("anything else?", history, agent).distance).toBe("absent");
  });
});
