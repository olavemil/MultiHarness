import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maintenanceTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { openKnowledgeDb } from "../src/knowledge/db.ts";
import { appendImpression } from "../src/knowledge/impressions.ts";
import { pendingMaintenance } from "../src/session/maintenance.ts";
import { runSession } from "../src/session/run.ts";
import { loadIdentity, saveIdentity } from "../src/store/identityStore.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { loadPriorSession } from "../src/store/priorSession.ts";
import { mockOllama, reply, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
} from "./helpers/fixtures.ts";

/**
 * Maintenance sessions: a session with no incoming message, run when a channel
 * has gone quiet. The sleep phase from harness.md, and the first trigger that is
 * not "somebody said something".
 */

const IMPRESSION = JSON.stringify({
  reading: "They ask narrow questions and act on short answers.",
  summary: "Wants the answer first; follows up when the reasoning matters.",
});
const REACTION = (respond: boolean) =>
  JSON.stringify({ reason: respond ? "asked me directly" : "not for me", respond });
const RESPONSE = JSON.stringify({ message: "Node 22 or newer." });
const REVIEW = JSON.stringify({ assessment: "Fine.", quality: 4, recommendations: [] });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(replies: MockReply[], tweak: (c: Config) => Config = (c) => c) {
  const { dir, cleanup } = await tempWorkingDir();
  const server: MockOllama = await mockOllama(replies);
  cleanups.push(cleanup, server.close);

  const base = await testConfig(server.host, dir);
  const config = tweak({
    ...base,
    session: {
      ...base.session,
      maintenance: { enabled: true, idle_ms: 1_000, steps: ["impression"] },
    },
  });
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  return { config, paths, server };
}

const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");

describe("maintenance sessions", () => {
  it("runs its configured steps with no message and no reply", async () => {
    const { config, paths } = await harness([reply(IMPRESSION)]);
    const db = openKnowledgeDb(paths.knowledge);
    for (let i = 0; i < 5; i++) {
      appendImpression(db, "operator", "operator", `observation ${i}`, {
        session: "s",
        step: "reflect",
      });
    }
    db.close();

    const result = await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "5 new impressions"),
      identity: testIdentity(),
      history: testHistory(),
    });

    // No react, no respond, no review — and `summarize` still leaves a record.
    expect(result.completed.map((s) => s.name)).toEqual(["impression", "summarize"]);
    expect(result.reply).toBeUndefined();
    expect(await read(result.session.dir, "summary.md")).toContain("No reply was sent");
  });

  it("synthesises from the impressions on record, which reflect did not load", async () => {
    // In an ordinary session `reflect` loads these as a side effect of appending
    // to them. Nothing does here, so the session has to load them itself or the
    // step summarises an empty list.
    const { config, paths, server } = await harness([reply(IMPRESSION)]);
    const db = openKnowledgeDb(paths.knowledge);
    appendImpression(db, "operator", "operator", "asked for the short version twice", {
      session: "s",
      step: "reflect",
    });
    db.close();

    await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "impressions pending"),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(server.requests[0]?.body.messages?.[0]?.content).toContain(
      "asked for the short version twice",
    );
  });

  it("refuses to respond even when configured to", async () => {
    // Enforced in code, not by config discipline. Nobody is waiting on a
    // maintenance session, so speaking into the channel would be the agent
    // talking to itself.
    const { config, paths } = await harness([reply(IMPRESSION)], (c) => ({
      ...c,
      session: { ...c.session, maintenance: { ...c.session.maintenance, steps: ["respond"] } },
    }));

    const result = await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "misconfigured"),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(result.completed.map((s) => s.name)).toEqual(["summarize"]);
    expect(result.reply).toBeUndefined();
  });

  it("does not become the session reflect reflects on", async () => {
    // A maintenance run has no exchange in it. Letting it claim the pointer
    // would have the next real session asking how the last answer landed when
    // there was no last answer.
    const { config, paths } = await harness([
      reply(REACTION(true)),
      reply(RESPONSE),
      reply(REVIEW),
      reply(IMPRESSION),
    ]);

    const real = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    });

    await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "housekeeping"),
      identity: testIdentity(),
      history: testHistory(),
    });

    const prior = await loadPriorSession(paths, "cli");
    expect(prior?.id).toBe(real.session.id);
  });

  it("records the impression count alongside the summary it wrote", async () => {
    const { config, paths } = await harness([reply(IMPRESSION)]);
    const db = openKnowledgeDb(paths.knowledge);
    for (let i = 0; i < 6; i++) {
      appendImpression(db, "operator", "operator", `observation ${i}`, {
        session: "s",
        step: "reflect",
      });
    }
    db.close();

    await runSession({
      config,
      paths,
      trigger: maintenanceTrigger("cli", "6 pending"),
      identity: testIdentity(),
      history: testHistory(),
    });

    const identity = await loadIdentity(paths, "operator");
    expect(identity.summary).toContain("Wants the answer first");
    // Counting *new* impressions is what lets an idle trigger fire on its own
    // schedule instead of on "every Nth append".
    expect(identity.synthesisedAt).toBe(6);
  });
});

describe("pendingMaintenance", () => {
  it("reports nothing to do until the threshold is crossed", async () => {
    const { config, paths } = await harness([]);
    const identity = testIdentity();
    const db = openKnowledgeDb(paths.knowledge);

    expect(await pendingMaintenance(paths, config, identity)).toBeUndefined();

    for (let i = 0; i < 4; i++) {
      appendImpression(db, identity.id, identity.displayName, `observation ${i}`, {
        session: "s",
        step: "reflect",
      });
    }
    db.close();
    expect(await pendingMaintenance(paths, config, identity)).toBeUndefined();
  });

  it("counts impressions since the last synthesis, not in total", async () => {
    const { config, paths } = await harness([]);
    const db = openKnowledgeDb(paths.knowledge);
    for (let i = 0; i < 6; i++) {
      appendImpression(db, "operator", "operator", `observation ${i}`, {
        session: "s",
        step: "reflect",
      });
    }
    db.close();

    const fresh = testIdentity();
    const work = await pendingMaintenance(paths, config, fresh);
    expect(work?.steps).toContain("impression");
    expect(work?.reason).toMatch(/6 new impressions/);

    // Already synthesised at 6: nothing new, so nothing to do — otherwise every
    // sweep would re-synthesise the same observations forever.
    const settled = { ...fresh, synthesisedAt: 6 };
    await saveIdentity(paths, settled);
    expect(await pendingMaintenance(paths, config, settled)).toBeUndefined();
  });

  it("stays silent while the feature is off", async () => {
    const { config, paths } = await harness([], (c) => ({
      ...c,
      session: { ...c.session, maintenance: { ...c.session.maintenance, enabled: false } },
    }));
    const db = openKnowledgeDb(paths.knowledge);
    for (let i = 0; i < 9; i++) {
      appendImpression(db, "operator", "operator", `observation ${i}`, {
        session: "s",
        step: "reflect",
      });
    }
    db.close();

    expect(await pendingMaintenance(paths, config, testIdentity())).toBeUndefined();
  });
});
