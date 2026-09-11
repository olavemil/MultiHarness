import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../src/session/run.ts";
import { messageTrigger } from "../src/core/trigger.ts";
import { loadConfig } from "../src/config/load.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { appendMessage } from "../src/store/channelStore.ts";
import { recordLastSession } from "../src/store/priorSession.ts";
import { createSession, sealStep } from "../src/store/sessionStore.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";
import { tempWorkingDir, testConfig, testIdentity, testMessage } from "./helpers/fixtures.ts";

/**
 * The `v2` flag is what makes the composition experiment measurable: two agents
 * in one daemon, one on each pipeline, against the same channels.
 *
 * These tests cover the two things that would make it useless — that it is off
 * unless an instance asks for it, and that asking for it actually changes which
 * pipeline runs.
 */

const servers: MockOllama[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const c of cleanups.splice(0)) await c();
});

const RESTATE = reply(
  JSON.stringify({
    resolved: true,
    request: "Whether the importer retries on failure.",
    openPoints: [],
  }),
);

const NO_WORK = reply(
  JSON.stringify({
    anythingWorthDoing: false,
    reason: "The question was answered; nothing is left over.",
    work: [],
  }),
);

const REFLECT = reply(
  JSON.stringify({
    assessment: "A new question; it says nothing about the last answer.",
    signal: "no_signal",
    correction: "",
    recommendations: [],
    impression: "asks precise questions",
  }),
);

async function runWith(v2: boolean, replies: ReturnType<typeof reply>[]) {
  const server = await mockOllama(replies);
  servers.push(server);

  const { dir, cleanup } = await tempWorkingDir();
  cleanups.push(cleanup);

  const base = await testConfig(server.host, dir);
  const config = { ...base, v2 };

  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const channelId = "C1";
  // History plus a prior session, so both v2 stages pass their conditions.
  await appendMessage(paths, channelId, {
    id: "m0",
    identityId: "u1",
    author: "ada",
    text: "how does the importer behave?",
    at: new Date().toISOString(),
    fromAgent: false,
  });
  // A real prior session, so `reflect` has something to reflect on and v1 and
  // v2 both meet the same starting conditions.
  const previous = await createSession(paths);
  await sealStep(previous, "review.md", "# Review\n\nThe last answer was too long.");
  await recordLastSession(paths, channelId, previous);

  const result = await runSession({
    config,
    paths,
    trigger: messageTrigger(testMessage({ channelId, text: "does the importer retry?" })),
    identity: testIdentity(),
    history: [{ id: "m0", identityId: "u1", author: "ada", text: "how does it behave?", at: "t", fromAgent: false }],
  });

  return { result, paths, server };
}

describe("the v2 flag", () => {
  it("is off in the shipped configuration", async () => {
    const warn = console.warn;
    console.warn = () => {};
    const shipped = await loadConfig(undefined, "/nonexistent-instance").finally(() => {
      console.warn = warn;
    });

    // Deliberately against the repo's "everything ships enabled" rule: the
    // point is running the two side by side, and defaulting it on leaves
    // nothing to compare against.
    expect(shipped.v2).toBe(false);
  });

  it("runs the v1 pipeline when off", async () => {
    const { result } = await runWith(false, [
      // With a prior session, v1 opens with `reflect`, then its entry pair,
      // then the closing steps. The step list is the assertion, not the count.
      REFLECT,
      reply(
        JSON.stringify({
          reason: "asks the agent",
          target: "nothing",
          addressee: "agent",
          wants: "answer",
        }),
      ),
      reply(JSON.stringify({ reason: "have something", interest: 0.9, reaction: "eyes" })),
      reply(JSON.stringify({ message: "Yes, three times." })),
      reply(JSON.stringify({ assessment: "fine", quality: 4, recommendations: [] })),
    ]);

    const names = result.completed.map((s) => s.name);
    expect(names).toContain("read");
    expect(names).toContain("stance");
    // The v2 pipeline's own step is absent, and v1's order is unchanged.
    expect(names.indexOf("reflect")).toBeLessThan(names.indexOf("read"));
  });

  it("runs the v2 pipeline when on, in the declared order", async () => {
    const { result } = await runWith(true, [RESTATE, REFLECT, NO_WORK]);

    // restate before reflect — the ordering the experiment exists to test.
    expect(result.completed.map((s) => s.name)).toEqual(["restate", "reflect", "schedule_work"]);
    expect(result.completed.map((s) => s.name).indexOf("restate")).toBeLessThan(
      result.completed.map((s) => s.name).indexOf("reflect"),
    );
  });

  it("seals v2 output into the same session directory as v1", async () => {
    const { result } = await runWith(true, [RESTATE, REFLECT, NO_WORK]);

    const request = await readFile(path.join(result.session.dir, "request.md"), "utf8");
    const reflection = await readFile(path.join(result.session.dir, "reflection.md"), "utf8");

    expect(request).toContain("Whether the importer retries on failure.");
    expect(reflection).toContain("no signal");
  });

  it("sends a prompt carrying no template variables and no placeholder prose", async () => {
    const { server } = await runWith(true, [RESTATE, REFLECT, NO_WORK]);

    const prompts = server.requests
      .filter((r) => r.path === "/api/chat")
      .map((r) => String(r.body.messages?.at(-1)?.content ?? ""));
    expect(prompts).toHaveLength(3);

    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/\$\{/);
      expect(prompt).not.toMatch(/\(no |\(none\)|\(nothing/);
    }
  });

  it("gives reflect the restatement that restate just sealed", async () => {
    const { server } = await runWith(true, [RESTATE, REFLECT, NO_WORK]);

    // Second of three now: restate, reflect, schedule_work.
    const reflectPrompt = String(
      server.requests
        .filter((r) => r.path === "/api/chat")
        .at(1)?.body.messages?.at(-1)?.content ?? "",
    );
    expect(reflectPrompt).toContain("## What it is asking");
    expect(reflectPrompt).toContain("Whether the importer retries on failure.");
    // Demoted under its heading, so the sealed H1 does not break the document.
    expect(reflectPrompt).not.toContain("\n# Request");
  });
});
