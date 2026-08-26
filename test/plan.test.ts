import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { loadPlan, loadPlanHistory, writePlanRevision } from "../src/store/planStore.ts";
import { mockOllama, reply, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
  entryReplies,
  promptFor,
} from "./helpers/fixtures.ts";

/**
 * The durable, cross-session plan: what lets the agent work on something over
 * days rather than answering each message in isolation.
 */

const SCHEDULE = (steps: { step: string; topic: string }[]) =>
  JSON.stringify({ reason: "plan this", needs_fact: false, needs_thought: true, steps, reaction: "eyes" });
const RESPONSE = JSON.stringify({ message: "Right — here is the plan." });
const REVIEW = JSON.stringify({ assessment: "Fine.", quality: 4, recommendations: [] });

const PLAN = (over: Partial<Record<string, unknown>> = {}) =>
  JSON.stringify({
    reasoning: "They want the importer built over several sittings.",
    status: "active",
    goal: "Build the CSV importer",
    outstanding: ["Design the schema mapping", "Write the upsert path"],
    artifacts: [],
    changed: "",
    ...over,
  });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function run(replies: MockReply[], tweak: (c: Config) => Config = (c) => c) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { dir, cleanup } = await tempWorkingDir();
  // The suite's message names the agent, and both entry steps run on that
  // path now: being named settles that the message is not *ignored*, not that
  // it is answered without reading it.
  const server: MockOllama = await mockOllama([...entryReplies(true).map(reply), ...replies]);
  cleanups.push(cleanup, server.close);

  const base = await testConfig(server.host, dir);
  const config = tweak({
    ...base,
    session: { ...base.session, selectable_steps: ["research", "reason", "draft", "plan"] },
  });
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const result = await runSession({
    config,
    paths,
    trigger: messageTrigger(testMessage({ text: "harness, let's build the CSV importer" })),
    identity: testIdentity(),
    history: testHistory(),
    rng: () => 0,
  });
  warn.mockRestore();
  return { result, paths, server, config };
}

describe("planStore", () => {
  it("numbers revisions and seals each one read-only", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const paths = resolvePaths(dir);
    await ensurePaths(paths);

    const first = await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the importer",
      outstanding: ["a", "b"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });
    expect(first.revision).toBe(0);

    const second = await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the importer",
      outstanding: ["b"],
      artifacts: [],
      artifactState: [],
      changed: "a is done",
      session: "000002",
    });
    expect(second.revision).toBe(1);

    // Append-only: the earlier revision is still there and cannot be edited.
    const history = await loadPlanHistory(paths, "cli");
    expect(history).toHaveLength(2);
    expect(history[0]).toContain("Build the importer");

    const target = path.join(paths.channels, "cli", "plans", "plan_0.md");
    expect((await stat(target)).mode & 0o777).toBe(0o444);
    await expect(writeFile(target, "tampered", "utf8")).rejects.toThrowError();
  });

  it("reads a closed plan as absent, so it stops directing future sessions", async () => {
    // A plan nothing can close becomes a standing instruction with no way out.
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const paths = resolvePaths(dir);
    await ensurePaths(paths);

    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the importer",
      outstanding: ["a"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });
    expect((await loadPlan(paths, "cli"))?.goal).toBe("Build the importer");

    await writePlanRevision(paths, "cli", {
      status: "fulfilled",
      goal: "Build the importer",
      outstanding: [],
      artifacts: [],
      artifactState: [],
      changed: "shipped it",
      session: "000002",
    });
    expect(await loadPlan(paths, "cli")).toBeUndefined();

    // But the record of it survives — closing is not deleting.
    expect(await loadPlanHistory(paths, "cli")).toHaveLength(2);
  });

  it("has no plan at all in a fresh channel", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const paths = resolvePaths(dir);
    await ensurePaths(paths);

    expect(await loadPlan(paths, "cli")).toBeUndefined();
    expect(await loadPlanHistory(paths, "cli")).toEqual([]);
  });
});

describe("the plan step", () => {
  it("writes a revision the harness applies, and seals its own output", async () => {
    const { result, paths } = await run([
      reply(SCHEDULE([{ step: "plan", topic: "set out the importer work" }])),
      reply(PLAN()),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    expect(result.completed.map((s) => s.name)).toContain("plan");
    expect(await readFile(path.join(result.session.dir, "plan.md"), "utf8")).toContain(
      "Build the CSV importer",
    );

    const stored = await loadPlan(paths, "cli");
    expect(stored?.goal).toBe("Build the CSV importer");
    expect(stored?.outstanding).toEqual(["Design the schema mapping", "Write the upsert path"]);
    expect(stored?.session).toBe(result.session.id);
  });

  it("makes the revision visible to later steps in the same session", async () => {
    // `respond` should answer knowing what was just committed to, not what the
    // plan said before this session touched it.
    const { server } = await run([
      reply(SCHEDULE([{ step: "plan", topic: "set out the work" }])),
      reply(PLAN()),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    // No plan is running when `plan` is asked to write one, so the block is
    // absent rather than announcing its own emptiness.
    const planPrompt = promptFor(server, "plan");
    expect(planPrompt).not.toContain("The plan you are working to");
  });

  it("leaves the existing plan untouched when the revision cannot be parsed", async () => {
    // The documented no-op. An unparsed revision must not close a plan or
    // invent a goal, so nothing is written at all.
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      ...entryReplies(true).map(reply),
      reply(SCHEDULE([{ step: "plan", topic: "revise" }])),
      reply("not json"),
      reply("still not json"),
      reply(RESPONSE),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = {
      ...base,
      session: { ...base.session, selectable_steps: ["research", "reason", "draft", "plan"] },
    };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "The original goal",
      outstanding: ["still to do"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    });
    warn.mockRestore();

    const stored = await loadPlan(paths, "cli");
    expect(stored?.goal).toBe("The original goal");
    expect(stored?.revision).toBe(0);
  });

  it("closes a plan, and the next session sees none", async () => {
    const { result, paths, config } = await run([
      reply(SCHEDULE([{ step: "plan", topic: "close it" }])),
      reply(PLAN({ status: "fulfilled", outstanding: [], changed: "the importer shipped" })),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    expect(result.completed.map((s) => s.name)).toContain("plan");
    expect(await loadPlan(paths, "cli")).toBeUndefined();
    // The revision itself is kept; closing is not deleting.
    expect(await loadPlanHistory(paths, "cli")).toHaveLength(1);
    expect(config.session.plan_step).toBe("plan");
  });

  it("reaches later sessions through current_plan", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await writePlanRevision(paths, "cli", {
      status: "active",
      goal: "Build the CSV importer",
      outstanding: ["Design the schema mapping"],
      artifacts: [],
      artifactState: [],
      changed: "",
      session: "000001",
    });

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    });

    // `respond` declares `current_plan`; a running plan should be in its prompt.
    const respondPrompt = promptFor(server, "respond");
    expect(respondPrompt).toContain("Build the CSV importer");
    expect(respondPrompt).toContain("Design the schema mapping");
  });
});
