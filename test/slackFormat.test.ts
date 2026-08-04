import { describe, expect, it } from "vitest";
import {
  channelIdFor,
  decodeText,
  shouldIgnore,
  type SlackMessage,
} from "../src/adapters/slack/format.ts";

const names: Record<string, string> = { U01: "olav", UBOT: "harness", U02: "dana" };
const resolve = (id: string) => names[id];

describe("decodeText", () => {
  it("rewrites user mentions to display names", () => {
    expect(decodeText("<@UBOT> what node version?", resolve)).toBe("@harness what node version?");
    expect(decodeText("<@U02> can you look?", resolve)).toBe("@dana can you look?");
  });

  it("keeps an unresolved id readable rather than leaking markup", () => {
    expect(decodeText("<@U99> hello", resolve)).toBe("@U99 hello");
  });

  it("unwraps links, channel refs, and html entities", () => {
    expect(decodeText("see <https://x.dev|the docs>", resolve)).toBe("see the docs");
    expect(decodeText("see <https://x.dev>", resolve)).toBe("see https://x.dev");
    expect(decodeText("in <#C01|general>", resolve)).toBe("in #general");
    expect(decodeText("a &amp; b &lt;c&gt;", resolve)).toBe("a & b <c>");
  });
});

describe("shouldIgnore", () => {
  const base: SlackMessage = { channel: "C1", user: "U01", text: "hello", ts: "1" };

  it("passes an ordinary message through", () => {
    expect(shouldIgnore(base, "UBOT")).toBe(false);
  });

  it("ignores the agent's own messages, which would otherwise loop", () => {
    expect(shouldIgnore({ ...base, user: "UBOT" }, "UBOT")).toBe(true);
  });

  it("does not filter other bots — the agent need not know who is human", () => {
    expect(shouldIgnore({ ...base, bot_id: "B123" }, "UBOT")).toBe(false);
  });

  it("ignores edits, deletions, and channel chrome", () => {
    expect(shouldIgnore({ ...base, subtype: "message_changed" }, "UBOT")).toBe(true);
    expect(shouldIgnore({ ...base, subtype: "channel_join" }, "UBOT")).toBe(true);
  });

  it("ignores empty or text-less events", () => {
    expect(shouldIgnore({ ...base, text: "   " }, "UBOT")).toBe(true);
    expect(shouldIgnore({ channel: "C1", user: "U01" }, "UBOT")).toBe(true);
  });
});

describe("channelIdFor", () => {
  const threaded: SlackMessage = { channel: "C1", thread_ts: "111.222", ts: "333.444" };

  it("gives a thread its own channel under separate mode", () => {
    expect(channelIdFor(threaded, "separate")).toBe("C1:111.222");
  });

  it("folds threads into the parent channel under shared mode", () => {
    expect(channelIdFor(threaded, "shared")).toBe("C1");
  });

  it("uses the bare channel for top-level messages either way", () => {
    const top: SlackMessage = { channel: "C1", ts: "1" };
    expect(channelIdFor(top, "separate")).toBe("C1");
    expect(channelIdFor(top, "shared")).toBe("C1");
  });
});
