import { describe, expect, it } from "vitest";
import { runToolLoop, toolSpec } from "../src/model/toolLoop.ts";
import { KNOWN_TOOL_NAMES, resolveTools } from "../src/tools/registry.ts";
import { knowledgeRead, knowledgeSearch, knowledgeWrite } from "../src/tools/knowledge.ts";
import { KNOWLEDGE, openMemoryDb } from "../src/knowledge/db.ts";
import { appendContent, createEntry, listEntries } from "../src/knowledge/store.ts";
import { embedding, mockOllama, reply, toolCall, type MockReply } from "./helpers/mockOllama.ts";
import { testConfig } from "./helpers/fixtures.ts";

const role = {
  name: "reasoning",
  model: "test-reasoning",
  backend: "ollama" as const,
  noTools: false,
  exclusive: false,
  options: {},
};

async function loop(
  replies: MockReply[],
  tools = resolveTools(["knowledge_search", "knowledge_read"]),
  maxIterations?: number,
) {
  const server = await mockOllama(replies);
  const config = await testConfig(server.host, "/tmp/unused");
  const db = openMemoryDb();

  const entry = createEntry(db, KNOWLEDGE, "docker networking", "bridge vs host", [1, 0], {
    session: "s", step: "seed",
  });
  appendContent(db, entry.id, "bridge is the default driver", { session: "s", step: "seed" });

  try {
    const result = await runToolLoop({
      label: "respond",
      host: server.host,
      role,
      prompt: "what do we know about docker?",
      tools,
      context: { config, knowledge: () => db, files: "/tmp", sessions: "/tmp", session: "s", step: "respond" },
      timeoutMs: 5_000,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    });
    return { result, db, server, config };
  } finally {
    await server.close();
  }
}

describe("tool registry", () => {
  it("names the known tools when an allowlist entry does not exist", () => {
    expect(() => resolveTools(["nonsense"])).toThrowError(/Known tools: .*knowledge_search/);
    expect(KNOWN_TOOL_NAMES).toContain("knowledge_write");
  });

  it("declares parameters to ollama as JSON Schema", () => {
    const spec = toolSpec(knowledgeSearch);
    expect(spec.function.name).toBe("knowledge_search");
    expect(spec.function.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
    });
  });
});

describe("runToolLoop", () => {
  it("executes a call, feeds the result back, and stops when the model answers", async () => {
    const { result } = await loop([
      toolCall("knowledge_search", { query: "docker" }),
      reply("Docker uses a bridge driver by default."),
    ]);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.name).toBe("knowledge_search");
    expect(result.calls[0]?.result).toContain("docker networking");
    expect(result.exhausted).toBe(false);
    expect(result.transcript).toContain("knowledge_search");
  });

  it("chains calls, so a search can be followed by a read", async () => {
    const { result } = await loop([
      toolCall("knowledge_search", { query: "docker" }),
      toolCall("knowledge_read", { topic: "docker networking" }),
      reply("done"),
    ]);

    expect(result.calls.map((c) => c.name)).toEqual(["knowledge_search", "knowledge_read"]);
    expect(result.calls[1]?.result).toContain("bridge is the default driver");
  });

  it("refuses a tool outside the allowlist as a result, not an exception", async () => {
    const { result } = await loop([toolCall("knowledge_write", { text: "x" }), reply("ok")]);

    // The step must survive the model reaching for something it was not given.
    expect(result.calls[0]?.error).toBe("not allowed");
    expect(result.calls[0]?.result).toContain("No tool named");
  });

  it("hands back a validation error the model can correct", async () => {
    const { result } = await loop([toolCall("knowledge_search", { wrong: 1 }), reply("ok")]);
    expect(result.calls[0]?.result).toContain("Arguments rejected");
    expect(result.calls[0]?.result).toContain("call knowledge_search again".replace("call", "Call"));
  });

  it("stops at the iteration cap rather than looping forever", async () => {
    const { result } = await loop(
      Array.from({ length: 8 }, () => toolCall("knowledge_search", { query: "docker" })),
      resolveTools(["knowledge_search", "knowledge_read"]),
      6,
    );
    expect(result.exhausted).toBe(true);
    expect(result.calls.length).toBeLessThanOrEqual(6);
  });

  it("routes writes through the gatekeeper rather than storing directly", async () => {
    const server = await mockOllama([
      toolCall("knowledge_write", { text: "Metal caps GPU memory at 75% of RAM." }),
      embedding([0, 1, 0]),
      reply(JSON.stringify({ reason: "new subject", verdict: "new", existing_topic: "none", new_topic: "metal memory", summary: "GPU ceiling" })),
      reply("stored"),
    ]);
    const config = await testConfig(server.host, "/tmp/unused");
    const db = openMemoryDb();

    try {
      const result = await runToolLoop({
        label: "research",
        host: server.host,
        role,
        prompt: "record what you know",
        tools: resolveTools(["knowledge_write"]),
        context: { config, knowledge: () => db, files: "/tmp", sessions: "/tmp", session: "s", step: "research" },
        timeoutMs: 5_000,
      });

      expect(result.calls[0]?.result).toContain('Stored as new topic "metal memory"');
      expect(listEntries(db, KNOWLEDGE).map((e) => e.topic)).toEqual(["metal memory"]);
    } finally {
      await server.close();
    }
  });
});

describe("knowledge tools", () => {
  it("marks the write tool as the only non-read-only one", () => {
    expect(knowledgeSearch.readOnly).toBe(true);
    expect(knowledgeRead.readOnly).toBe(true);
    expect(knowledgeWrite.readOnly).toBe(false);
  });
});
