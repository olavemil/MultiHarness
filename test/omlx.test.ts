import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat, embed } from "../src/model/omlx.ts";
import { callModel } from "../src/model/call.ts";
import { ModelError, ModelTimeout } from "../src/model/transport.ts";
import type { ResolvedRole } from "../src/model/roles.ts";
import { mockOmlx, reply } from "./helpers/mockOmlx.ts";

/**
 * oMLX speaks an OpenAI-compatible API (SSE, `response_format`,
 * `chat_template_kwargs`), not ollama's (NDJSON, `format`, `think`) — see the
 * module comment in `src/model/omlx.ts` for which of these mappings are
 * confirmed against oMLX's own docs and which are informed guesses that still
 * want checking against a live instance. These tests pin the mapping this
 * client actually sends and parses, so a future correction to an unverified
 * guess shows up as a deliberate edit here rather than a silent drift.
 */

const role: ResolvedRole = {
  name: "reasoning",
  model: "qwen3.8:27b-mlx",
  backend: "omlx",
  noTools: false,
  exclusive: false,
  options: { temperature: 0.2 },
};

describe("omlx chat()", () => {
  it("aggregates SSE content deltas the way ollama.ts aggregates NDJSON ones", async () => {
    const server = await mockOmlx([reply("hello world")]);
    try {
      const result = await chat(server.host, { model: role.model, messages: [{ role: "user", content: "hi" }] }, {
        timeoutMs: 5_000,
      });
      expect(result.content).toBe("hello world");
      expect(result.promptTokens).toBe(11);
      expect(result.responseTokens).toBe(7);
    } finally {
      await server.close();
    }
  });

  it("reads reasoning off reasoning_content, separate from content", async () => {
    const server = await mockOmlx([{ kind: "content", content: "answer", reasoning: "thinking it through" }]);
    try {
      const result = await chat(server.host, { model: role.model, messages: [{ role: "user", content: "hi" }] }, {
        timeoutMs: 5_000,
      });
      expect(result.content).toBe("answer");
      expect(result.thinking).toBe("thinking it through");
    } finally {
      await server.close();
    }
  });

  it("sends a JSON Schema as response_format, not ollama's format field", async () => {
    const server = await mockOmlx([reply('{"ok":true}')]);
    try {
      await chat(
        server.host,
        {
          model: role.model,
          messages: [{ role: "user", content: "hi" }],
          format: { type: "object", properties: { ok: { type: "boolean" } } },
        },
        { timeoutMs: 5_000 },
      );
      const sent = server.requests[0]?.body.response_format as {
        type: string;
        json_schema: { schema: unknown };
      };
      expect(sent.type).toBe("json_schema");
      expect(sent.json_schema.schema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    } finally {
      await server.close();
    }
  });

  it("sends think as chat_template_kwargs.enable_thinking", async () => {
    const server = await mockOmlx([reply("ok")]);
    try {
      await chat(
        server.host,
        { model: role.model, messages: [{ role: "user", content: "hi" }], think: false },
        { timeoutMs: 5_000 },
      );
      expect(server.requests[0]?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    } finally {
      await server.close();
    }
  });

  it("accumulates a streamed tool call by index and assigns it an id", async () => {
    const server = await mockOmlx([{ kind: "tools", id: "call_abc", name: "knowledge_search", args: { q: "x" } }]);
    try {
      const result = await chat(server.host, { model: role.model, messages: [{ role: "user", content: "hi" }] }, {
        timeoutMs: 5_000,
      });
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: "call_abc",
        function: { name: "knowledge_search", arguments: { q: "x" } },
      });
    } finally {
      await server.close();
    }
  });

  it("round-trips a tool result with tool_call_id so the server can correlate it", async () => {
    const server = await mockOmlx([reply("done")]);
    try {
      await chat(
        server.host,
        {
          model: role.model,
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_abc", function: { name: "knowledge_search", arguments: { q: "x" } } }],
            },
            { role: "tool", tool_name: "knowledge_search", content: "found nothing", tool_call_id: "call_abc" },
          ],
        },
        { timeoutMs: 5_000 },
      );
      const wireMessages = server.requests[0]?.body.messages ?? [];
      expect(wireMessages.at(-1)?.tool_call_id).toBe("call_abc");
      const assistantCall = wireMessages[1]?.tool_calls as { id: string; function: { arguments: string } }[];
      // OpenAI's wire format wants arguments as a JSON string, not the parsed object.
      expect(assistantCall[0]?.function.arguments).toBe('{"q":"x"}');
    } finally {
      await server.close();
    }
  });

  it("throws ModelError, not a bare fetch error, on a non-2xx response", async () => {
    const server = await mockOmlx([{ kind: "status", status: 500, body: "model not found" }]);
    try {
      await expect(
        chat(server.host, { model: role.model, messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 5_000 }),
      ).rejects.toBeInstanceOf(ModelError);
    } finally {
      await server.close();
    }
  });

  it("carries partial content in a ModelTimeout, the same shape ollama.ts uses for salvage", async () => {
    const server = await mockOmlx([{ kind: "content", content: '{"reason":"got this far', hang: true }]);
    try {
      await chat(server.host, { model: role.model, messages: [{ role: "user", content: "hi" }] }, {
        timeoutMs: 200,
      }).catch((cause) => {
        expect(cause).toBeInstanceOf(ModelTimeout);
        expect((cause as ModelTimeout).partialContent).toBe('{"reason":"got this far');
      });
    } finally {
      await server.close();
    }
  });
});

describe("omlx embed()", () => {
  it("maps /v1/embeddings' {data:[{embedding,index}]} into ollama.ts's number[][] shape", async () => {
    const server = await mockOmlx([{ kind: "embed", vectors: [[1, 0], [0, 1]] }]);
    try {
      const result = await embed(server.host, "qwen3-embedding", ["a", "b"], { timeoutMs: 5_000 });
      expect(result.embeddings).toEqual([[1, 0], [0, 1]]);
    } finally {
      await server.close();
    }
  });
});

describe("callModel dispatches to omlx when the role's backend is omlx", () => {
  const schema = z.object({ respond: z.boolean() });

  it("hits /v1/chat/completions rather than /api/chat", async () => {
    const server = await mockOmlx([reply('{"respond":true}')]);
    try {
      const result = await callModel({
        label: "test",
        host: server.host,
        role,
        prompt: "decide",
        schema,
        fallback: () => ({ respond: false }),
        timeoutMs: 5_000,
      });
      expect(result.value).toEqual({ respond: true });
      expect(server.requests[0]?.path).toBe("/v1/chat/completions");
    } finally {
      await server.close();
    }
  });
});
