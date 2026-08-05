import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { KNOWLEDGE, openKnowledgeDb, openMemoryDb } from "../src/knowledge/db.ts";
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
import {
  appendImpression,
  impressionCount,
  readImpressions,
} from "../src/knowledge/impressions.ts";
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

describe("impressions", () => {
  it("accumulates one exchange at a time, never rewriting", () => {
    const db = openMemoryDb();
    appendImpression(db, "olav", "olav", "asked a follow-up about the reasoning", {
      session: "1", step: "reflect",
    });
    appendImpression(db, "olav", "olav", "moved straight past the detail", {
      session: "2", step: "reflect",
    });

    expect(readImpressions(db, "olav").map((i) => i.text)).toEqual([
      "asked a follow-up about the reasoning",
      "moved straight past the detail",
    ]);
    expect(impressionCount(db, "olav")).toBe(2);
  });

  it("keeps one entry per identity and creates it on first impression", () => {
    const db = openMemoryDb();
    appendImpression(db, "olav", "olav", "one", { session: "1", step: "reflect" });
    appendImpression(db, "olav", "olav", "two", { session: "2", step: "reflect" });
    appendImpression(db, "dana", "dana", "three", { session: "3", step: "reflect" });

    expect(listEntries(db, "identity").map((e) => e.topic).sort()).toEqual(["dana", "olav"]);
  });

  it("ignores an empty impression rather than storing a blank", () => {
    const db = openMemoryDb();
    appendImpression(db, "olav", "olav", "   ", { session: "1", step: "reflect" });
    expect(impressionCount(db, "olav")).toBe(0);
  });

  it("keeps people out of the knowledge namespace", () => {
    const db = openMemoryDb();
    appendImpression(db, "olav", "olav", "one", { session: "1", step: "reflect" });
    // The research gatekeeper's shortlist must never surface a person.
    expect(listEntries(db, KNOWLEDGE)).toHaveLength(0);
  });

  it("records which session and step formed each impression", () => {
    const db = openMemoryDb();
    appendImpression(db, "olav", "olav", "one", { session: "000007", step: "reflect" });
    expect(readImpressions(db, "olav")[0]).toMatchObject({
      session: "000007",
      step: "reflect",
    });
  });
});

/**
 * Opening a store that predates a schema change.
 *
 * Every other test here starts from `openMemoryDb`, which builds the current
 * schema from scratch — so a migration could be completely broken and the suite
 * would stay green. It was: an index over `superseded_by` sat in the schema
 * block, which runs *before* the migration, and on an existing store the
 * `CREATE TABLE IF NOT EXISTS` above it is a no-op. The index referenced a
 * column that did not exist yet and threw, taking the whole session with it.
 * Caught in a live agent, not here.
 */
describe("opening a store written by an older build", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  /** The `contents` table exactly as it stood before compaction existed. */
  async function legacyStore(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "multiharness-legacy-"));
    dirs.push(dir);
    const db = new DatabaseSync(path.join(dir, "knowledge.sqlite"));
    db.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, topic TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL,
        created_session TEXT NOT NULL, embedding BLOB, UNIQUE (namespace, topic)
      );
      CREATE TABLE contents (
        id INTEGER PRIMARY KEY,
        entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        text TEXT NOT NULL, session TEXT NOT NULL, step TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE entries_fts USING fts5(topic, summary, body);
      CREATE TABLE rejections (
        id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, candidate TEXT NOT NULL,
        verdict TEXT NOT NULL, reason TEXT NOT NULL, session TEXT NOT NULL,
        step TEXT NOT NULL, at TEXT NOT NULL
      );
      INSERT INTO entries (namespace, topic, summary, created_at, created_session)
        VALUES ('knowledge', 'metal memory', 'the ceiling', '2026-08-04', '000001');
      INSERT INTO contents (entry_id, text, session, step, at)
        VALUES (1, 'about 36 GB', '000001', 'research', '2026-08-04');
    `);
    db.close();
    return dir;
  }

  it("adds the column instead of throwing", async () => {
    const dir = await legacyStore();
    const db = openKnowledgeDb(dir);

    const columns = (db.prepare("PRAGMA table_info(contents)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain("superseded_by");
    db.close();
  });

  it("leaves what was already stored alone", async () => {
    const dir = await legacyStore();
    const db = openKnowledgeDb(dir);

    const entry = findEntry(db, KNOWLEDGE, "metal memory");
    expect(entry).toBeDefined();
    // Pre-existing rows have a null `superseded_by`, so they read as live.
    expect(readContents(db, entry!.id).map((c) => c.text)).toEqual(["about 36 GB"]);
    db.close();
  });

  it("is safe to open twice", async () => {
    const dir = await legacyStore();
    openKnowledgeDb(dir).close();
    expect(() => openKnowledgeDb(dir).close()).not.toThrow();
  });
});
