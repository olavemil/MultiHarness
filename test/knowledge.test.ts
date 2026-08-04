import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE, openMemoryDb } from "../src/knowledge/db.ts";
import {
  appendContent,
  createEntry,
  findEntry,
  listEntries,
  readContents,
  rejectionCount,
  search,
} from "../src/knowledge/store.ts";
import { cosine } from "../src/knowledge/similarity.ts";
import { writeKnowledge } from "../src/knowledge/gatekeeper.ts";
import { embedding, mockOllama, reply, type MockReply } from "./helpers/mockOllama.ts";
import { testConfig } from "./helpers/fixtures.ts";

const prov = { session: "000001", step: "research" };

const gatekeeperReply = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    reason: "…",
    verdict: "new",
    existing_topic: "none",
    new_topic: "",
    summary: "",
    ...fields,
  });

/** Mock server serves the embedding call first, then the gatekeeper call. */
async function withGatekeeper(replies: MockReply[]) {
  const server = await mockOllama(replies);
  const config = await testConfig(server.host, "/tmp/unused");
  return { server, config, db: openMemoryDb() };
}

describe("knowledge store", () => {
  it("keeps content append-only with provenance", () => {
    const db = openMemoryDb();
    const entry = createEntry(db, KNOWLEDGE, "docker networking", "bridge vs host", [1, 0], prov);

    appendContent(db, entry.id, "bridge is the default", prov);
    appendContent(db, entry.id, "host skips the NAT layer", {
      session: "000002",
      step: "reason",
    });

    const contents = readContents(db, entry.id);
    expect(contents.map((c) => c.text)).toEqual([
      "bridge is the default",
      "host skips the NAT layer",
    ]);
    expect(contents[1]).toMatchObject({ session: "000002", step: "reason" });
  });

  it("refuses two entries with the same topic in a namespace", () => {
    const db = openMemoryDb();
    createEntry(db, KNOWLEDGE, "docker networking", "…", [1, 0], prov);
    expect(() => createEntry(db, KNOWLEDGE, "docker networking", "…", [1, 0], prov)).toThrow();
  });

  it("keeps identity entries out of the knowledge namespace", () => {
    const db = openMemoryDb();
    createEntry(db, KNOWLEDGE, "docker networking", "…", [1, 0], prov);
    createEntry(db, "identity", "olav", "runs the harness", [0, 1], prov);

    // Same topic name is fine across namespaces, and a knowledge listing must
    // not be polluted with people's names.
    expect(listEntries(db, KNOWLEDGE).map((e) => e.topic)).toEqual(["docker networking"]);
    expect(listEntries(db, "identity").map((e) => e.topic)).toEqual(["olav"]);
  });

  it("finds entries by full-text search over topic and content", () => {
    const db = openMemoryDb();
    const entry = createEntry(db, KNOWLEDGE, "docker networking", "bridge vs host", [1, 0], prov);
    appendContent(db, entry.id, "the NAT layer adds latency on macOS", prov);

    expect(search(db, KNOWLEDGE, "networking").map((e) => e.topic)).toEqual(["docker networking"]);
    expect(search(db, KNOWLEDGE, "latency").map((e) => e.topic)).toEqual(["docker networking"]);
    expect(search(db, KNOWLEDGE, "kubernetes")).toEqual([]);
  });
});

describe("cosine", () => {
  it("scores identical vectors at 1 and orthogonal ones at 0", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe("gatekeeper", () => {
  it("creates an entry when nothing similar exists", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply(gatekeeperReply({ verdict: "new", new_topic: "Docker Networking", summary: "bridge vs host" })),
    ]);
    try {
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "docker bridge networking adds a NAT hop",
        provenance: prov,
      });

      expect(result.verdict).toBe("new");
      // Topics are normalised, so casing cannot fork one subject into two.
      expect(result.entry?.topic).toBe("docker networking");
      expect(readContents(db, result.entry!.id)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("appends to an existing topic instead of duplicating it", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply(gatekeeperReply({ verdict: "append", existing_topic: "docker networking" })),
    ]);
    try {
      const existing = createEntry(db, KNOWLEDGE, "docker networking", "…", [1, 0, 0], prov);
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "host mode skips NAT entirely",
        provenance: prov,
      });

      expect(result.verdict).toBe("append");
      expect(result.entry?.id).toBe(existing.id);
      expect(listEntries(db, KNOWLEDGE)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("shows the model only the nearest topics, not the whole store", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply(gatekeeperReply({ verdict: "reject" })),
    ]);
    try {
      createEntry(db, KNOWLEDGE, "close topic", "…", [1, 0, 0], prov);
      createEntry(db, KNOWLEDGE, "distant topic", "…", [0, 0, 1], prov);

      await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "something",
        provenance: prov,
        shortlist: 1,
      });

      const prompt = server.requests[1]?.body.messages?.[0]?.content ?? "";
      expect(prompt).toContain("close topic");
      expect(prompt).not.toContain("distant topic");
    } finally {
      await server.close();
    }
  });

  it("logs a rejection with its reason rather than dropping it silently", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply(gatekeeperReply({ verdict: "reject", reason: "restates the previous message" })),
    ]);
    try {
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "olav asked about node versions",
        provenance: prov,
      });

      expect(result.verdict).toBe("reject");
      expect(listEntries(db, KNOWLEDGE)).toHaveLength(0);
      expect(rejectionCount(db, KNOWLEDGE)).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects rather than guessing when append names an unknown topic", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply(gatekeeperReply({ verdict: "append", existing_topic: "none" })),
    ]);
    try {
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "something",
        provenance: prov,
      });

      // Filing text under the wrong entry is worse than not filing it.
      expect(result.verdict).toBe("reject");
      expect(rejectionCount(db, KNOWLEDGE)).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects on a parse failure — a bad entry is permanent, a dropped one is not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server, config, db } = await withGatekeeper([
      embedding([1, 0, 0]),
      reply("not json"),
      reply("still not json"),
    ]);
    try {
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "something",
        provenance: prov,
      });
      expect(result.verdict).toBe("reject");
      expect(rejectionCount(db, KNOWLEDGE)).toBe(1);
    } finally {
      warn.mockRestore();
      await server.close();
    }
  });

  it("folds a proposed topic that already exists into an append", async () => {
    const { server, config, db } = await withGatekeeper([
      embedding([0, 1, 0]),
      reply(gatekeeperReply({ verdict: "new", new_topic: "docker networking" })),
    ]);
    try {
      // Nowhere near in embedding space, so it never reaches the shortlist —
      // but the name collides, and the unique constraint would otherwise throw.
      const existing = createEntry(db, KNOWLEDGE, "docker networking", "…", [1, 0, 0], prov);
      const result = await writeKnowledge({
        db,
        config,
        namespace: KNOWLEDGE,
        candidate: "bridge mode detail",
        provenance: prov,
        shortlist: 0,
      });

      expect(result.verdict).toBe("append");
      expect(result.entry?.id).toBe(existing.id);
      expect(findEntry(db, KNOWLEDGE, "docker networking")).toBeDefined();
    } finally {
      await server.close();
    }
  });
});
