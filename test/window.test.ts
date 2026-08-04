import { describe, expect, it } from "vitest";
import { renderWindow, resolveLocalId, windowEntries, windowIds } from "../src/core/window.ts";
import type { ChannelMessage } from "../src/core/types.ts";

const msg = (author: string, text: string, fromAgent = false): ChannelMessage => ({
  id: `uuid-${author}-${text.length}`,
  identityId: fromAgent ? "agent" : author,
  author,
  text,
  at: "2026-08-03T09:14:00.000Z",
  fromAgent,
});

describe("message window", () => {
  it("numbers messages oldest first and keeps only the most recent", () => {
    const history = Array.from({ length: 20 }, (_, i) => msg("olav", `message ${i}`));
    const entries = windowEntries(history, 12);

    expect(entries).toHaveLength(12);
    expect(entries[0]?.localId).toBe("m1");
    expect(entries[0]?.message.text).toBe("message 8");
    expect(entries.at(-1)?.localId).toBe("m12");
  });

  it("renders id, time, sender, and content", () => {
    const rendered = renderWindow(windowEntries([msg("olav", "morning")], 12));
    expect(rendered).toMatch(/^\[m1\] \d{2}:\d{2} olav: morning$/);
  });

  it("labels the agent's own messages as 'you'", () => {
    const rendered = renderWindow(windowEntries([msg("agent", "Node 22.", true)], 12));
    expect(rendered).toContain("you: Node 22.");
  });

  it("never exposes a real message id to the model", () => {
    const rendered = renderWindow(windowEntries([msg("olav", "morning")], 12));
    expect(rendered).not.toContain("uuid-");
  });

  it("maps a local id back to the real message", () => {
    const entries = windowEntries([msg("olav", "first"), msg("dana", "second")], 12);
    expect(resolveLocalId(entries, "m2")?.text).toBe("second");
    expect(resolveLocalId(entries, "m9")).toBeUndefined();
  });

  it("lists the ids a model may legally reference", () => {
    const entries = windowEntries([msg("a", "x"), msg("b", "y")], 12);
    expect(windowIds(entries)).toEqual(["m1", "m2"]);
  });

  it("describes an empty channel rather than rendering nothing", () => {
    expect(renderWindow([])).toContain("no earlier messages");
  });
});
