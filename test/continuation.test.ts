import { afterEach, describe, expect, it, vi } from "vitest";
import { continuationTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { progressBetween, shouldContinue } from "../src/session/continuation.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { loadPlan, loadPlanHistory, writePlanRevision, type Plan } from "../src/store/planStore.ts";
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
 * Continued work: carrying on with an unfinished plan after a reply.
 *
 * Every gate is countable, and the tests are mostly about the gates rather than
 * the work — a background loop that talks itself into running is the failure
 * this design exists to make impossible.
 */

const THOUGHTS = JSON.stringify({ thinking: "…", conclusion: "mapped it", uncertainties: [] });
const PLAN = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    reasoning: "One item is done.",
    status: "active",
    goal: "Build the CSV importer",
    outstanding: ["Write the upsert path"],
    artifacts: [],
    changed: "Schema mapping finished.",
    ...over,
  });

const plan = (over: Partial<Plan> = {}): Plan => ({
  revision: 0,
  status: "active",
  goal: "Build the CSV importer",
  outstanding: ["Design the schema mapping", "Write the upsert path"],
  artifacts: [],
  artifactState: [],
  changed: "",
  session: "000001",
  at: new Date().toISOString(),
  ...over,
});

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
      continuation: { enabled: true, steps: ["reason"], max_iterations: 3 },
    },
  });
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);
  return { config, paths, server };
}

/** The config the gates are checked against. */
async function gateConfig(over: Record<string, unknown> = {}): Promise<Config> {
  const { dir, cleanup } = await tempWorkingDir();
  cleanups.push(cleanup);
  const base = await testConfig("http://127.0.0.1:1", dir);
  return {
    ...base,
    session: {
      ...base.session,
      continuation: { enabled: true, steps: ["reason"], max_iterations: 3, ...over },
    },
  };
}

describe("progressBetween", () => {
  it("counts closed items rather than asking whether progress was made", () => {
    // The judgement the roadmap wanted a step for. Two plan revisions settle it,
    // and a model asked "did you make progress?" says yes.
    const before = plan({ outstanding: ["a", "b", "c"] });
    const after = plan({ outstanding: ["c"] });

    expect(progressBetween(before, after)).toEqual({
      progressed: true,
      closed: 2,
      artifactsChanged: 0,
      finished: false,
    });
  });

  it("reports no progress when the list did not shrink", () => {
    const before = plan({ outstanding: ["a", "b"] });
    expect(progressBetween(before, plan({ outstanding: ["a", "b"] })).progressed).toBe(false);
    // A plan that *grew* is not progress either, however busy the iteration was.
    expect(progressBetween(before, plan({ outstanding: ["a", "b", "c"] })).closed).toBe(-1);
  });

  it("measures a plan's declared artifacts rather than its own account", () => {
    // The whole point of naming files. The plan step says an item is done; the
    // file either grew or it did not, and only one of those is checkable.
    const before = plan({
      outstanding: ["a", "b"],
      artifacts: ["notes/design.md"],
      artifactState: [{ path: "notes/design.md", exists: false, size: 0 }],
    });

    const claimedOnly = plan({
      outstanding: ["b"],
      artifacts: ["notes/design.md"],
      artifactState: [{ path: "notes/design.md", exists: false, size: 0 }],
    });
    // An item was struck off and nothing was written. Not progress.
    expect(progressBetween(before, claimedOnly).progressed).toBe(false);
    expect(progressBetween(before, claimedOnly).closed).toBe(1);

    const written = plan({
      outstanding: ["b"],
      artifacts: ["notes/design.md"],
      artifactState: [{ path: "notes/design.md", exists: true, size: 400 }],
    });
    expect(progressBetween(before, written)).toMatchObject({
      progressed: true,
      artifactsChanged: 1,
    });
  });

  it("counts an artifact that grew, not just one that appeared", () => {
    const state = (size: number) => [{ path: "notes/design.md", exists: true, size }];
    const before = plan({ artifacts: ["notes/design.md"], artifactState: state(400) });

    expect(
      progressBetween(before, plan({ artifacts: ["notes/design.md"], artifactState: state(900) }))
        .progressed,
    ).toBe(true);
    // Unchanged, or smaller, is not progress — a rewrite that lost content is
    // not an iteration to keep going from.
    expect(
      progressBetween(before, plan({ artifacts: ["notes/design.md"], artifactState: state(400) }))
        .progressed,
    ).toBe(false);
    expect(
      progressBetween(before, plan({ artifacts: ["notes/design.md"], artifactState: state(100) }))
        .progressed,
    ).toBe(false);
  });

  it("falls back to closed items when the plan names no files", () => {
    // Deliberative plans produce a decision, not a document. Requiring an
    // artifact would make them permanently stalled.
    const before = plan({ outstanding: ["a", "b"] });
    expect(progressBetween(before, plan({ outstanding: ["b"] })).progressed).toBe(true);
  });

  it("treats a closed plan as progress, whichever way it closed", () => {
    // `loadPlan` returns nothing for a closed plan, so an absent `after` means
    // this iteration closed it. Abandoning a plan that turned out to be wrong is
    // a result, not a failure to report.
    const delta = progressBetween(plan({ outstanding: ["a"] }), undefined);
    expect(delta).toEqual({ progressed: true, closed: 1, artifactsChanged: 0, finished: true });
  });
});

describe("shouldContinue", () => {
  const base = { replied: true, pending: 0, nextIteration: 1 };

  it("continues while a plan has items left", async () => {
    const config = await gateConfig();
    expect(shouldContinue({ ...base, config, plan: plan() })).toMatch(/2 items still outstanding/);
  });

  it("refuses when the agent chose not to reply", async () => {
    // Background work on a message the agent declined to answer is work nobody
    // asked for.
    const config = await gateConfig();
    expect(shouldContinue({ ...base, config, plan: plan(), replied: false })).toBeUndefined();
  });

  it("refuses when anything is queued for the channel", async () => {
    // A waiting message outranks background work, and may change the plan.
    const config = await gateConfig();
    expect(shouldContinue({ ...base, config, plan: plan(), pending: 1 })).toBeUndefined();
  });

  it("refuses with no plan, or a plan with nothing outstanding", async () => {
    const config = await gateConfig();
    expect(shouldContinue({ ...base, config, plan: undefined })).toBeUndefined();
    expect(shouldContinue({ ...base, config, plan: plan({ outstanding: [] }) })).toBeUndefined();
  });

  it("stops at the iteration cap", async () => {
    const config = await gateConfig({ max_iterations: 2 });
    expect(shouldContinue({ ...base, config, plan: plan(), nextIteration: 2 })).toBeTruthy();
    expect(shouldContinue({ ...base, config, plan: plan(), nextIteration: 3 })).toBeUndefined();
  });

  it("stops when the last iteration closed nothing", async () => {
    // What stops a plan being ground at forever. An iteration that produced no
    // closed item has not progressed, whatever it would say about itself.
    const config = await gateConfig();
    const stalled = { progressed: false, closed: 0, artifactsChanged: 0, finished: false };
    expect(shouldContinue({ ...base, config, plan: plan(), delta: stalled })).toBeUndefined();
  });

  it("stops once the plan is closed", async () => {
    const config = await gateConfig();
    const done = { progressed: true, closed: 1, artifactsChanged: 0, finished: true };
    expect(shouldContinue({ ...base, config, plan: plan(), delta: done })).toBeUndefined();
  });

  it("is off unless enabled", async () => {
    const config = await gateConfig({ enabled: false });
    expect(shouldContinue({ ...base, config, plan: plan() })).toBeUndefined();
  });
});

describe("a continuation session", () => {
  it("works the plan and revises it, without replying", async () => {
    const { config, paths } = await harness([reply(THOUGHTS), reply(PLAN())]);
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the CSV importer",
      outstanding: ["Design the schema mapping", "Write the upsert path"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    const result = await runSession({
      config,
      paths,
      trigger: continuationTrigger("cli", 1, "2 items still outstanding"),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(result.completed.map((s) => s.name)).toEqual(["reason", "plan", "summarize"]);
    expect(result.reply).toBeUndefined();
    // One item closed, counted from the revisions rather than claimed.
    expect(result.progress).toEqual({
      progressed: true,
      closed: 1,
      artifactsChanged: 0,
      finished: false,
    });
  });

  it("refuses to respond even when configured to", async () => {
    const { config, paths } = await harness([reply(PLAN())], (c) => ({
      ...c,
      session: {
        ...c.session,
        continuation: { ...c.session.continuation, steps: ["respond"] },
      },
    }));
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "g",
      outstanding: ["a"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    const result = await runSession({
      config,
      paths,
      trigger: continuationTrigger("cli", 1, "work left"),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect(result.completed.map((s) => s.name)).toEqual(["plan", "summarize"]);
    expect(result.reply).toBeUndefined();
  });

  it("reports to the channel when it closes the plan", async () => {
    // Somebody told "I'll look into it" is owed the outcome where they asked.
    // `changed` is both the record of the revision and the text of the report.
    const sent: string[] = [];
    const { config, paths } = await harness([
      reply(THOUGHTS),
      reply(PLAN({ status: "fulfilled", outstanding: [], changed: "The importer is done." })),
    ]);
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the CSV importer",
      outstanding: ["Write the upsert path"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    const result = await runSession({
      config,
      paths,
      trigger: continuationTrigger("cli", 1, "1 item outstanding"),
      identity: testIdentity(),
      history: testHistory(),
      onReply: async (text) => void sent.push(text),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Finished: Build the CSV importer");
    expect(sent[0]).toContain("The importer is done.");
    expect(result.progress?.finished).toBe(true);
    expect(await loadPlan(paths, "cli")).toBeUndefined();
  });

  it("says so when it drops a plan rather than finishing it", async () => {
    const sent: string[] = [];
    const { config, paths } = await harness([
      reply(THOUGHTS),
      reply(PLAN({ status: "abandoned", outstanding: [], changed: "The vendor feed replaced it." })),
    ]);
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the CSV importer",
      outstanding: ["Write the upsert path"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    await runSession({
      config,
      paths,
      trigger: continuationTrigger("cli", 1, "1 item outstanding"),
      identity: testIdentity(),
      history: testHistory(),
      onReply: async (text) => void sent.push(text),
    });

    // A plan that quietly dies is worse than one that never started.
    expect(sent[0]).toContain("Dropping: Build the CSV importer");
    expect(sent[0]).toContain("vendor feed");
  });

  it("does not become the session reflect reflects on", async () => {
    // A continuation has no exchange in it. Letting it claim the pointer would
    // have the next real session asking how the last answer landed.
    const REACTION = JSON.stringify({ reason: "asked me", respond: true });
    const RESPONSE = JSON.stringify({ message: "Right." });
    const REVIEW = JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] });
    const { config, paths } = await harness([
      reply(REACTION),
      reply(RESPONSE),
      reply(REVIEW),
      reply(THOUGHTS),
      reply(PLAN()),
    ]);
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "g",
      outstanding: ["a", "b"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

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
      trigger: continuationTrigger("cli", 1, "work left"),
      identity: testIdentity(),
      history: testHistory(),
    });

    expect((await loadPriorSession(paths, "cli"))?.id).toBe(real.session.id);
  });

  it("leaves every revision behind, so a plan's drift stays traceable", async () => {
    const { config, paths } = await harness([reply(THOUGHTS), reply(PLAN())]);
    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the CSV importer",
      outstanding: ["Design the schema mapping", "Write the upsert path"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    await runSession({
      config,
      paths,
      trigger: continuationTrigger("cli", 1, "work left"),
      identity: testIdentity(),
      history: testHistory(),
    });

    const history = await loadPlanHistory(paths, "cli");
    expect(history).toHaveLength(2);
    expect(history[1]).toContain("Schema mapping finished.");
  });
});
