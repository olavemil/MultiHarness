import { describe, expect, it, vi } from "vitest";
import { resolveReplyTarget } from "../src/session/replyTarget.ts";
import type { ChannelMessage } from "../src/core/types.ts";
import { mockOllama, reply, type MockReply } from "./helpers/mockOllama.ts";
import { testConfig, testIdentity, testMessage } from "./helpers/fixtures.ts";

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
  msg("agent", "Node 22 or newer.", true),
  msg("dana", "I'll bump the CI image"),
];

async function resolve(replies: MockReply[], text = "and why that one?") {
  const server = await mockOllama(replies);
  try {
    const config = await testConfig(server.host, "/tmp/unused");
    const result = await resolveReplyTarget(config, {
      message: testMessage({ text }),
      history,
      identity: testIdentity(),
      completed: [],
    });
    return { result, server };
  } finally {
    await server.close();
  }
}

describe("resolveReplyTarget", () => {
  it("classifies a reply to one of the agent's own messages", async () => {
    const { result } = await resolve([
      reply(JSON.stringify({ reason: "picks up the version answer", target: "m2" })),
    ]);

    expect(result.kind).toBe("agent");
    expect(result.localId).toBe("m2");
  });

  it("classifies a reply to somebody else's message", async () => {
    const { result } = await resolve([
      reply(JSON.stringify({ reason: "responds to the CI remark", target: "m3" })),
    ]);
    expect(result.kind).toBe("other");
  });

  it("classifies an opening message as replying to nothing", async () => {
    const { result } = await resolve([
      reply(JSON.stringify({ reason: "starts a new subject", target: "nothing" })),
    ]);

    expect(result.kind).toBe("nothing");
    expect(result.localId).toBeUndefined();
  });

  it("constrains decoding to ids actually present, plus nothing", async () => {
    const { server } = await resolve([
      reply(JSON.stringify({ reason: "…", target: "nothing" })),
    ]);

    const format = server.requests[0]?.body.format as {
      properties: { target: { enum: string[] } };
    };
    expect(format.properties.target.enum).toEqual(["nothing", "m1", "m2", "m3"]);
  });

  it("shows the model local ids and never a real message id", async () => {
    const { server } = await resolve([
      reply(JSON.stringify({ reason: "…", target: "nothing" })),
    ]);

    const prompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(prompt).toContain("[m2]");
    expect(prompt).not.toContain("uuid-");
  });

  it("asserts nothing rather than inventing a link when parsing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await resolve([reply("not json"), reply("still not json")]);
    warn.mockRestore();

    expect(result.kind).toBe("nothing");
    expect(result.trace.fellBack).toBe(true);
  });
});
