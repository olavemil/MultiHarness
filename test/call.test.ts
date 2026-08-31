import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callModel } from "../src/model/call.ts";
import { ModelError } from "../src/model/transport.ts";
import type { ResolvedRole } from "../src/model/roles.ts";
import { mockOllama, reply, type MockReply } from "./helpers/mockOllama.ts";

const Reaction = z.object({
  respond: z.boolean(),
  steps: z.array(z.string()),
});
type Reaction = z.infer<typeof Reaction>;

const FALLBACK: Reaction = { respond: true, steps: ["respond"] };

const role: ResolvedRole = {
  name: "fast",
  model: "test-model",
  backend: "ollama",
  noTools: false, exclusive: false,
  options: { temperature: 0.2 },
};

async function call(replies: MockReply[]) {
  const server = await mockOllama(replies);
  try {
    const result = await callModel({
      label: "react",
      host: server.host,
      role,
      prompt: "decide",
      schema: Reaction,
      fallback: () => FALLBACK,
      timeoutMs: 5_000,
    });
    return { result, server };
  } finally {
    await server.close();
  }
}

describe("callModel", () => {
  it("accepts a valid first response without retrying", async () => {
    const { result, server } = await call([reply('{"respond":true,"steps":["respond"]}')]);

    expect(result.value).toEqual({ respond: true, steps: ["respond"] });
    expect(result.trace.fellBack).toBe(false);
    expect(result.trace.attempts).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it("sends the Zod schema as ollama's format field for constrained decoding", async () => {
    const { server } = await call([reply('{"respond":false,"steps":[]}')]);

    expect(server.requests[0]?.body.format).toMatchObject({
      type: "object",
      properties: { respond: { type: "boolean" } },
    });
    expect(server.requests[0]?.body.options).toEqual({ temperature: 0.2 });
  });

  it("puts the schema's keys on the wire in declaration order", async () => {
    // The invariant four steps depend on and nothing asserted. Constrained
    // decoding emits keys in schema order, which is why `reason` is declared
    // before the verdict it justifies — that reordering alone took react from
    // 9/10 to 10/10 and separately fixed `adjust`, `restate` and `plan`.
    //
    // Two ways it could silently break: Zod could stop preserving declaration
    // order in `toJSONSchema`, or `JSON.stringify` could reorder on the way
    // out. Both are checked here, against the bytes actually sent.
    const ordered = z.object({
      reason: z.string(),
      verdict: z.enum(["reply", "tangent"]),
      interest: z.number(),
    });
    expect(Object.keys(z.toJSONSchema(ordered).properties as object)).toEqual([
      "reason",
      "verdict",
      "interest",
    ]);

    const { server } = await call([reply('{"respond":false,"steps":[]}')]);
    const sent = JSON.stringify(server.requests[0]?.body.format);
    expect(sent.indexOf('"respond"')).toBeLessThan(sent.indexOf('"steps"'));
  });

  it("retries once with the validation error fed back, then succeeds", async () => {
    const { result, server } = await call([
      reply('{"respond":"yes","steps":[]}'), // wrong type for respond
      reply('{"respond":true,"steps":[]}'),
    ]);

    expect(result.value).toEqual({ respond: true, steps: [] });
    expect(result.trace.fellBack).toBe(false);
    expect(result.trace.attempts).toHaveLength(2);
    expect(result.trace.attempts[0]?.validationError).toContain("respond");

    // The retry must carry the prior response and the specific error.
    const retryMessages = server.requests[1]?.body.messages ?? [];
    expect(retryMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(retryMessages.at(-1)?.content).toContain("respond");
  });

  it("falls back to the documented default when both attempts fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await call([reply("not json at all"), reply('{"respond":42}')]);

    expect(result.value).toEqual(FALLBACK);
    expect(result.trace.fellBack).toBe(true);
    expect(result.trace.attempts).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("salvages JSON wrapped in a markdown fence rather than burning the retry", async () => {
    const { result } = await call([
      reply('```json\n{"respond":true,"steps":["respond"]}\n```'),
    ]);

    expect(result.value).toEqual({ respond: true, steps: ["respond"] });
    expect(result.trace.attempts).toHaveLength(1);
  });

  it("sums token counts across attempts", async () => {
    const { result } = await call([
      { kind: "content", content: "garbage", promptTokens: 10, responseTokens: 3 },
      { kind: "content", content: '{"respond":true,"steps":[]}', promptTokens: 20, responseTokens: 5 },
    ]);

    expect(result.trace.promptTokens).toBe(30);
    expect(result.trace.responseTokens).toBe(8);
  });

  it("throws on transport failure instead of silently falling back", async () => {
    await expect(
      call([{ kind: "status", status: 500, body: "model not found" }]),
    ).rejects.toBeInstanceOf(ModelError);
  });
});
