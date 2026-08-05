import { afterEach, describe, expect, it } from "vitest";
import { maintenanceTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { KNOWLEDGE, openKnowledgeDb, openMemoryDb } from "../src/knowledge/db.ts";
import {
  applyCompaction,
  compactionCandidates,
  COMPACT_STEP,
  MIN_BLOCKS,
} from "../src/knowledge/compaction.ts";
import { appendContent, createEntry, readAllContents, readContents } from "../src/knowledge/store.ts";
import { pendingMaintenance } from "../src/session/maintenance.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";
import { tempWorkingDir, testConfig, testHistory, testIdentity } from "./helpers/fixtures.ts";

/**
 * Knowledge compaction. Strict by construction: three or more live blocks to
 * qualify, one entry per maintenance session, within an entry only, and nothing
 * is ever deleted.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const prov = { session: "s1", step: "research" };

/** An entry with `n` appended notes. */
function seed(db: ReturnType<typeof openMemoryDb>, topic: string, n: number) {
  const entry = createEntry(db, KNOWLEDGE, topic, `about ${topic}`, undefined, prov);
  for (let i = 0; i < n; i++) {
    appendContent(db, entry.id, `note ${i} about ${topic}`, { session: `s${i}`, step: "research" });
  }
  return entry;
}

describe("compactionCandidates", () => {
  it("ignores entries below the threshold", () => {
    const db = openMemoryDb();
    seed(db, "one note", 1);
    seed(db, "two notes", 2);

    expect(compactionCandidates(db, KNOWLEDGE)).toEqual([]);
    expect(MIN_BLOCKS).toBe(3);
    db.close();
  });

  it("selects entries with three or more, most-appended first", () => {
    const db = openMemoryDb();
    seed(db, "three notes", 3);
    seed(db, "five notes", 5);
    seed(db, "two notes", 2);

    const candidates = compactionCandidates(db, KNOWLEDGE);
    expect(candidates.map((c) => c.entry.topic)).toEqual(["five notes", "three notes"]);
    expect(candidates[0]?.blocks).toHaveLength(5);
    db.close();
  });

  it("does not offer identity impressions, which are a different namespace", () => {
    // The research gatekeeper's shortlist is kept clear of people's names for
    // the same reason: two namespaces, never mixed.
    const db = openMemoryDb();
    const person = createEntry(db, "identity", "olav", "Impressions of olav", undefined, prov);
    for (let i = 0; i < 5; i++) {
      appendContent(db, person.id, `observation ${i}`, prov);
    }

    expect(compactionCandidates(db, KNOWLEDGE)).toEqual([]);
    db.close();
  });

  it("drops out once compacted, and needs three fresh notes to return", () => {
    // The threshold counts *notes*, not blocks. Counting blocks let a compacted
    // entry re-qualify on two new notes, with the earlier compaction making up
    // the third — halving the threshold the second time round.
    const db = openMemoryDb();
    const entry = seed(db, "metal memory", 4);

    applyCompaction(db, entry.id, "The ceiling is ~36 GB.", { session: "s9", step: COMPACT_STEP });
    expect(compactionCandidates(db, KNOWLEDGE)).toEqual([]);

    appendContent(db, entry.id, "note a", prov);
    appendContent(db, entry.id, "note b", prov);
    expect(compactionCandidates(db, KNOWLEDGE)).toEqual([]);

    appendContent(db, entry.id, "note c", prov);
    expect(compactionCandidates(db, KNOWLEDGE).map((c) => c.entry.topic)).toEqual(["metal memory"]);
    db.close();
  });

  it("ranks by fresh notes, so a compacted entry does not jump the queue", () => {
    // Two entries with three fresh notes each; one also carries a compaction
    // block. Ranking on total blocks would put it first for a block that is a
    // summary rather than a note.
    const db = openMemoryDb();
    const compacted = seed(db, "already compacted", 3);
    applyCompaction(db, compacted.id, "Merged.", { session: "s9", step: COMPACT_STEP });
    for (const text of ["x", "y", "z"]) appendContent(db, compacted.id, text, prov);

    seed(db, "never compacted", 4);

    const ranked = compactionCandidates(db, KNOWLEDGE).map((c) => c.entry.topic);
    expect(ranked[0]).toBe("never compacted");
    db.close();
  });
});

describe("applyCompaction", () => {
  it("keeps every original block, which is what makes compaction safe", () => {
    const db = openMemoryDb();
    const entry = seed(db, "metal memory", 3);

    applyCompaction(db, entry.id, "Merged.", { session: "s9", step: COMPACT_STEP });

    // What readers see.
    expect(readContents(db, entry.id).map((c) => c.text)).toEqual(["Merged."]);
    // What is still on disk: the originals, plus the compaction.
    expect(readAllContents(db, entry.id)).toHaveLength(4);
    expect(readAllContents(db, entry.id)[0]?.text).toBe("note 0 about metal memory");
    db.close();
  });

  it("refuses an empty compaction rather than emptying the entry", () => {
    // The one outcome that genuinely loses an entry: everything else is
    // recoverable by reading the originals back.
    const db = openMemoryDb();
    const entry = seed(db, "metal memory", 3);

    expect(applyCompaction(db, entry.id, "   ", { session: "s9", step: COMPACT_STEP })).toBe(false);
    expect(readContents(db, entry.id)).toHaveLength(3);
    db.close();
  });

  it("records provenance on the compacted block", () => {
    const db = openMemoryDb();
    const entry = seed(db, "metal memory", 3);

    applyCompaction(db, entry.id, "Merged.", { session: "000042", step: COMPACT_STEP });

    const [block] = readContents(db, entry.id);
    expect(block?.session).toBe("000042");
    expect(block?.step).toBe("compact");
    db.close();
  });
});

describe("compaction in a maintenance session", () => {
  async function harness(replies: string[], steps = ["compact"]) {
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama(replies.map((r) => reply(r)));
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config: Config = {
      ...base,
      session: {
        ...base.session,
        maintenance: { enabled: true, idle_ms: 1_000, steps },
      },
    };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);
    return { config, paths, server };
  }

  const COMPACTION = JSON.stringify({
    reasoning: "Three notes, two of which restate the same limit.",
    compacted: "Metal caps GPU-wired memory at ~75% above 36 GB, so the real ceiling is ~36 GB.",
  });

  it("compacts the most-appended entry and supersedes what it merged", async () => {
    const { config, paths } = await harness([COMPACTION]);
    const db = openKnowledgeDb(paths.knowledge);
    const small = seed(db, "small topic", 3);
    const big = seed(db, "metal memory", 5);
    db.close();

    const result = await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "entries have notes to merge", ["compact"]),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(result.completed.map((s) => s.name)).toEqual(["compact", "summarize"]);

    const after = openKnowledgeDb(paths.knowledge);
    // The most-appended entry was the one taken.
    expect(readContents(after, big.id).map((c) => c.text)).toEqual([
      "Metal caps GPU-wired memory at ~75% above 36 GB, so the real ceiling is ~36 GB.",
    ]);
    expect(readAllContents(after, big.id)).toHaveLength(6);
    // One entry per session: the other candidate is untouched.
    expect(readContents(after, small.id)).toHaveLength(3);
    after.close();
  });

  it("gives the step the notes it is merging, with their provenance", async () => {
    const { config, paths, server } = await harness([COMPACTION]);
    const db = openKnowledgeDb(paths.knowledge);
    seed(db, "metal memory", 3);
    db.close();

    await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "notes to merge", ["compact"]),
      identity: testIdentity(),
      history: testHistory(),
    });

    const prompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(prompt).toContain("note 0 about metal memory");
    expect(prompt).toContain("note 2 about metal memory");
    expect(prompt).toContain("metal memory");
    // Provenance is part of the material: which note is later settles a conflict.
    expect(prompt).toContain("session s0");
  });

  it("drops the step when nothing qualifies rather than merging an empty list", async () => {
    const { config, paths, server } = await harness([]);
    const db = openKnowledgeDb(paths.knowledge);
    seed(db, "only two", 2);
    db.close();

    const result = await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "stale trigger", ["compact"]),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(result.completed.map((s) => s.name)).toEqual(["summarize"]);
    expect(server.requests).toHaveLength(0);
  });

  it("leaves the entry alone when the model returns nothing usable", async () => {
    const { config, paths } = await harness(["not json", "still not json"]);
    const db = openKnowledgeDb(paths.knowledge);
    const entry = seed(db, "metal memory", 3);
    db.close();

    await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "notes to merge", ["compact"]),
      identity: testIdentity(),
      history: testHistory(),
    });

    const after = openKnowledgeDb(paths.knowledge);
    expect(readContents(after, entry.id)).toHaveLength(3);
    after.close();
  });
});

describe("pendingMaintenance with compaction", () => {
  it("schedules compaction only when an entry qualifies", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const base = await testConfig("http://127.0.0.1:1", dir);
    const config: Config = {
      ...base,
      session: {
        ...base.session,
        maintenance: { enabled: true, idle_ms: 1_000, steps: ["impression", "compact"] },
      },
    };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    expect(await pendingMaintenance(paths, config, testIdentity())).toBeUndefined();

    const db = openKnowledgeDb(paths.knowledge);
    seed(db, "metal memory", 3);
    db.close();

    const work = await pendingMaintenance(paths, config, testIdentity());
    expect(work?.steps).toEqual(["compact"]);
    expect(work?.reason).toContain("metal memory");
  });
});
