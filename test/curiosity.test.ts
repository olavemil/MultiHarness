import { describe, expect, it } from "vitest";
import { openMemoryDb, CURIOSITY } from "../src/knowledge/db.ts";
import {
  closeCuriosity,
  openCuriosities,
  recordCuriosity,
  recordPursuit,
} from "../src/knowledge/curiosity.ts";
import { listEntries } from "../src/knowledge/store.ts";
import { loose } from "../src/session/harvest.ts";
import { pendingMaintenance } from "../src/session/maintenance.ts";
import { mockOllama, embedding } from "./helpers/mockOllama.ts";
import { testConfig, testIdentity } from "./helpers/fixtures.ts";
import type { Config } from "../src/config/schema.ts";

const prov = { session: "000001", step: "research" };

/**
 * A server that returns a fixed vector per text, so "the same question asked
 * differently" is controllable rather than a property of a real model.
 */
async function withEmbeddings(vectors: Record<string, number[]>) {
  const server = await mockOllama([], {
    embed: (input: string) => vectors[input] ?? [0, 0, 1],
  });
  const config = await testConfig(server.host, "/tmp/unused");
  return { server, config };
}

describe("harvesting what steps already report", () => {
  it("takes research gaps, reason uncertainties, and debrief's unanswered", () => {
    // None of this is judged. Each field already exists, is already written by a
    // step asked exactly the right question, and was already discarded at
    // session end — so harvesting is a copy, not a decision.
    expect(loose("research", { findings: "", gaps: ["what version ships"] })).toEqual([
      "what version ships",
    ]);
    expect(loose("reason", { thinking: "", conclusion: "", uncertainties: ["whether it scales"] })).toEqual(
      ["whether it scales"],
    );
    expect(loose("debrief", { assessment: "", unanswered: ["is staging up?"], carry_forward: "" })).toEqual(
      ["is staging up?"],
    );
  });

  it("takes nothing from a step that reports no loose ends", () => {
    expect(loose("respond", { message: "Node 22." })).toEqual([]);
    expect(loose("summarize", {})).toEqual([]);
  });
});

describe("the curiosity store", () => {
  it("records an open question with the channel it came from", async () => {
    const { server, config } = await withEmbeddings({ "what version ships": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      const c = await recordCuriosity(db, config, "what version ships", "cli", prov);
      expect(c?.question).toBe("what version ships");
      expect(c?.channelId).toBe("cli");
      expect(c?.resurfaced).toBe(1);
      expect(c?.pursued).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("merges the same question asked differently, and counts it as recurrence", async () => {
    // Merging is what makes recurrence countable, and recurrence is the whole
    // signal. Kept apart, two phrasings are two questions that never look
    // pressing; merged, they are one that has now come up twice.
    const { server, config } = await withEmbeddings({
      "what version ships": [1, 0, 0],
      "which release the vendor is on": [0.99, 0.1, 0],
    });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "what version ships", "cli", prov);
      await recordCuriosity(db, config, "which release the vendor is on", "cli", prov);

      const open = openCuriosities(db);
      expect(open).toHaveLength(1);
      expect(open[0]?.resurfaced).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("keeps an unrelated question separate", async () => {
    const { server, config } = await withEmbeddings({
      "what version ships": [1, 0, 0],
      "who owns the deploy key": [0, 1, 0],
    });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "what version ships", "cli", prov);
      await recordCuriosity(db, config, "who owns the deploy key", "cli", prov);
      expect(openCuriosities(db)).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("does not let pursuing one make it look more urgent", async () => {
    // Recurrence is the block count and a pursuit appends a block, so without
    // excluding it by provenance an idle agent would research the same thing
    // every quiet period, each pass making the next one likelier. The same
    // shape that halved `compact`'s threshold on every pass after the first.
    const { server, config } = await withEmbeddings({ "what version ships": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      const c = await recordCuriosity(db, config, "what version ships", "cli", prov);
      recordPursuit(db, c!.id, "Pursued in session 000002 (research).", "000002");
      recordPursuit(db, c!.id, "Pursued in session 000003 (research).", "000003");

      const [after] = openCuriosities(db);
      expect(after?.resurfaced).toBe(1);
      expect(after?.pursued).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("orders the most persistent first", async () => {
    const { server, config } = await withEmbeddings({
      quiet: [1, 0, 0],
      loud: [0, 1, 0],
    });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "quiet", "cli", prov);
      await recordCuriosity(db, config, "loud", "cli", prov);
      await recordCuriosity(db, config, "loud", "cli", prov);
      expect(openCuriosities(db).map((c) => c.question)).toEqual(["loud", "quiet"]);
    } finally {
      await server.close();
    }
  });

  it("closes without deleting, so a bad close can be read back", async () => {
    // Append-only, like everything else here. Closing is not forgetting.
    const { server, config } = await withEmbeddings({ "what version ships": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      const c = await recordCuriosity(db, config, "what version ships", "cli", prov);
      closeCuriosity(db, c!.id, "answered by the vendor changelog");

      expect(openCuriosities(db)).toEqual([]);
      expect(listEntries(db, CURIOSITY)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("does not reopen a closed question when it is asked again", async () => {
    // Reopening would undo a deliberate close, which is the one thing a store
    // with no delete path cannot recover from.
    const { server, config } = await withEmbeddings({ "what version ships": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      const first = await recordCuriosity(db, config, "what version ships", "cli", prov);
      closeCuriosity(db, first!.id, "settled");

      const second = await recordCuriosity(db, config, "what version ships", "cli", prov);
      expect(second?.id).not.toBe(first!.id);
      expect(openCuriosities(db)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("what an idle agent does about it", () => {
  const pursue = async (config: Config, db: ReturnType<typeof openMemoryDb>) =>
    pendingMaintenance({ knowledge: "" } as never, config, testIdentity(), "cli", db);

  it("leaves a question that has only come up once", async () => {
    // A loose end, not something the agent keeps needing. `pursue_after` is 2.
    const { server, config } = await withEmbeddings({ "asked once": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "asked once", "cli", prov);
      expect(await pursue(config, db)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("goes and researches one that keeps coming back", async () => {
    const { server, config } = await withEmbeddings({ "keeps coming up": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "keeps coming up", "cli", prov);
      await recordCuriosity(db, config, "keeps coming up", "cli", prov);

      const work = await pursue(config, db);
      expect(work?.steps).toEqual(["research"]);
      expect(work?.reason).toBe("keeps coming up");
      expect(work?.curiosity?.question).toBe("keeps coming up");
    } finally {
      await server.close();
    }
  });

  it("starts a plan once researching it has evidently not settled it", async () => {
    // A plan is a commitment later sessions act on unprompted, so it takes more
    // than persistence: `escalate_after` is well above `pursue_after`.
    const { server, config } = await withEmbeddings({ "will not settle": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      for (let i = 0; i < 4; i++) {
        await recordCuriosity(db, config, "will not settle", "cli", prov);
      }
      const work = await pursue(config, db);
      expect(work?.steps).toEqual(["research", "plan"]);
    } finally {
      await server.close();
    }
  });

  it("pursues only what belongs to the channel that went quiet", async () => {
    // Pursuit can escalate into a plan and plans are per-channel, so pursuing
    // something in whichever room fell quiet first would file it in the wrong
    // place. The *store* stays cross-channel, which is what makes the count
    // meaningful.
    const { server, config } = await withEmbeddings({ elsewhere: [1, 0, 0] });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "elsewhere", "other-channel", prov);
      await recordCuriosity(db, config, "elsewhere", "other-channel", prov);
      expect(await pursue(config, db)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("does nothing at all when the feature is off", async () => {
    const { server, config } = await withEmbeddings({ "keeps coming up": [1, 0, 0] });
    try {
      const db = openMemoryDb();
      await recordCuriosity(db, config, "keeps coming up", "cli", prov);
      await recordCuriosity(db, config, "keeps coming up", "cli", prov);
      const off = {
        ...config,
        session: { ...config.session, curiosity: { ...config.session.curiosity, enabled: false } },
      };
      expect(await pursue(off, db)).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe("end to end", () => {
  it("harvests a research gap out of a live session, unprompted", async () => {
    // The whole point: the agent noticed what it did not know, and this time it
    // is still there afterwards. Before this, `gaps` was sealed, read by
    // `respond` in the same session, and never seen again.
    const { tempWorkingDir } = await import("./helpers/fixtures.ts");
    const { runSession } = await import("../src/session/run.ts");
    const { messageTrigger } = await import("../src/core/trigger.ts");
    const { ensurePaths, resolvePaths } = await import("../src/store/paths.ts");
    const { openKnowledgeDb } = await import("../src/knowledge/db.ts");
    const { entryReplies, testHistory, testMessage } = await import("./helpers/fixtures.ts");
    const { reply } = await import("./helpers/mockOllama.ts");

    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama(
      [
        ...entryReplies(true).map(reply),
        reply(
          JSON.stringify({
            reason: "needs looking up",
            needs_fact: true,
            needs_thought: false,
            steps: [{ step: "research", topic: "find the version" }],
            reaction: "mag",
          }),
        ),
        reply(
          JSON.stringify({
            findings: "The changelog does not say.",
            gaps: ["which release the vendor is actually on"],
          }),
        ),
        reply(JSON.stringify({ message: "Their changelog does not say." })),
        reply(JSON.stringify({ assessment: "ok", quality: 3, recommendations: [] })),
      ],
      { embed: () => [1, 0, 0] },
    );

    try {
      const base = await testConfig(server.host, dir);
      const config = {
        ...base,
        session: { ...base.session, selectable_steps: ["research"] },
        steps: { ...base.steps, research: { ...base.steps["research"], tools: [] } },
      };
      const paths = resolvePaths(config.working_dir);
      await ensurePaths(paths);

      await runSession({
        config,
        paths,
        trigger: messageTrigger(testMessage()),
        identity: testIdentity(),
        history: testHistory(),
        rng: () => 0,
      });

      const db = openKnowledgeDb(paths.knowledge);
      const open = openCuriosities(db);
      db.close();

      expect(open.map((c) => c.question)).toEqual(["which release the vendor is actually on"]);
      expect(open[0]?.channelId).toBe("cli");
    } finally {
      await server.close();
      await cleanup();
    }
  });

  it("closes what prune named, and only the harness closes it", async () => {
    // No step closes a curiosity on its own authority — the same arrangement as
    // knowledge writes going through the gatekeeper and plans being written
    // only by the plan step.
    const { tempWorkingDir } = await import("./helpers/fixtures.ts");
    const { runSession } = await import("../src/session/run.ts");
    const { maintenanceTrigger } = await import("../src/core/trigger.ts");
    const { ensurePaths, resolvePaths } = await import("../src/store/paths.ts");
    const { openKnowledgeDb } = await import("../src/knowledge/db.ts");
    const { testHistory } = await import("./helpers/fixtures.ts");
    const { reply } = await import("./helpers/mockOllama.ts");

    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama(
      [
        reply(
          JSON.stringify({
            reasoning: "One was never a real question.",
            close: [{ question: "a passing aside", why: "not a real question" }],
          }),
        ),
      ],
      { embed: (input: string) => (input === "a passing aside" ? [1, 0, 0] : [0, 1, 0]) },
    );

    try {
      const config = await testConfig(server.host, dir);
      const paths = resolvePaths(config.working_dir);
      await ensurePaths(paths);

      const db = openKnowledgeDb(paths.knowledge);
      await recordCuriosity(db, config, "a passing aside", "cli", prov);
      await recordCuriosity(db, config, "something worth keeping", "cli", prov);
      db.close();

      await runSession({
        config,
        paths,
        trigger: maintenanceTrigger("cli", "tidying up", ["prune"]),
        identity: testIdentity(),
        history: testHistory(),
      });

      const after = openKnowledgeDb(paths.knowledge);
      const open = openCuriosities(after);
      after.close();

      expect(open.map((c) => c.question)).toEqual(["something worth keeping"]);
    } finally {
      await server.close();
      await cleanup();
    }
  });
})
