import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession } from "../src/session/run.ts";
import { maintenanceTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, toolCall, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import { tempWorkingDir, testConfig, testHistory, testIdentity, testMessage } from "./helpers/fixtures.ts";

const REACTION = (respond: boolean) =>
  JSON.stringify({ reason: respond ? "asked me directly" : "aimed at someone else", respond });
const SCHEDULE = JSON.stringify({
  reason: "answer directly",
  needs_fact: false,
  needs_thought: false,
  steps: [],
});
const RESPONSE = JSON.stringify({ message: "Node 22 or newer." });
const REVIEW = JSON.stringify({ assessment: "Answered directly.", quality: 4, recommendations: [] });
const DEBRIEF = JSON.stringify({
  assessment: "One follow-up arrived and the session folded it into the answer.",
  unanswered: [],
  carry_forward: "",
});
const REFLECTION = JSON.stringify({
  assessment: "A new question; the previous answer was not commented on.",
  signal: "no_signal",
  correction: "",
  recommendations: [],
  impression: "",
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs one full session against a mocked model server. */
async function run(
  replies: MockReply[],
  message = testMessage(),
  tweak: (c: Config) => Config = (c) => c,
) {
  const { dir, cleanup } = await tempWorkingDir();
  const server: MockOllama = await mockOllama(replies);
  cleanups.push(cleanup, server.close);

  const config = tweak(await testConfig(server.host, dir));
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const result = await runSession({
    config,
    paths,
    trigger: messageTrigger(message),
    identity: testIdentity(),
    history: testHistory(),
    rng: () => 0,
  });

  return { result, server, paths };
}

const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");

describe("runSession", () => {
  it("runs react -> respond -> summarize -> review and seals every output", async () => {
    const { result } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");

    for (const file of ["reaction.md", "response.md", "summary.md", "review.md"]) {
      await expect(read(result.session.dir, file)).resolves.toBeTruthy();
    }
  });

  it("makes sealed output read-only on disk, not merely by convention", async () => {
    const { result } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);
    const target = path.join(result.session.dir, "response.md");

    expect((await stat(target)).mode & 0o777).toBe(0o444);
    await expect(writeFile(target, "tampered", "utf8")).rejects.toThrowError();
  });

  it("records the prompt variant, model, and rendered prompt in the trace", async () => {
    const { result } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);
    const meta = JSON.parse(await read(result.session.traceDir, "react.meta.json"));

    expect(meta.variantId).toBe("react_1");
    expect(meta.model).toBe("test-fast");
    expect(meta.role).toBe("fast");
    expect(meta.fellBack).toBe(false);
    expect(meta.contextBlocks.map((b: { name: string }) => b.name)).toEqual([
      "user_summary",
      "recent_messages",
      "incoming_message",
      "reflection",
    ]);

    // The prompt actually sent is reproducible from the trace alone.
    const prompt = await read(result.session.traceDir, "react.prompt.md");
    expect(prompt).toContain("what version of node is this project on?");
    expect(prompt).not.toContain("${");
    await expect(read(result.session.traceDir, "react.raw.txt")).resolves.toContain("respond");
  });

  it("routes each step to the model role its config assigns", async () => {
    const { server } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);

    expect(server.requests.map((r) => r.body.model)).toEqual([
      "test-fast", // react
      "test-reasoning", // respond
      "test-digest", // review
    ]);
    // `digest` reuses the reasoning weights with thinking off.
    expect(server.requests[2]?.body.think).toBe(false);
  });

  it("skips straight to the closing steps when react declines to respond", async () => {
    const { result, server } = await run([reply(REACTION(false)), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual(["react", "summarize", "review"]);
    expect(result.reply).toBeUndefined();
    expect(server.requests).toHaveLength(2);

    await expect(read(result.session.dir, "response.md")).rejects.toThrowError();
    expect(await read(result.session.dir, "reaction.md")).toContain("**Respond:** no");
  });

  it("completes the session on a documented default when a step cannot be parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await run([
      reply("not json"),
      reply("still not json"),
      reply(RESPONSE),
      reply(REVIEW),
    ]);
    warn.mockRestore();

    // react fell back to "respond anyway", so the pipeline continued intact.
    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");

    const meta = JSON.parse(await read(result.session.traceDir, "react.meta.json"));
    expect(meta.fellBack).toBe(true);
    expect(meta.attempts).toBe(2);
    expect(meta.validationErrors).toHaveLength(2);

    // And the fallback is visible in the sealed output and the summary.
    expect(await read(result.session.dir, "reaction.md")).toContain("could not be parsed");
    expect(await read(result.session.dir, "summary.md")).toContain("fell back to default");
  });

  it("feeds later steps the output of earlier ones", async () => {
    const { server } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);
    const reviewPrompt = server.requests[2]?.body.messages?.[0]?.content ?? "";

    // review judges the quality of the reply, so it has to be able to see it.
    // Without this the step rates every session against a timing table alone.
    expect(reviewPrompt).toContain("Node 22 or newer.");

    // ...alongside the structural record of what ran.
    expect(reviewPrompt).toContain("Session summary");
    expect(reviewPrompt).toContain("| react |");
  });

  it("keeps bookkeeping steps out of prior_step_output", async () => {
    const { server } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);
    const reviewPrompt = server.requests[2]?.body.messages?.[0]?.content ?? "";

    // react's routing decision and summarize's table are not work product; the
    // summary appears once, under its own heading, not duplicated as output.
    expect(reviewPrompt).not.toContain("## react");
    expect(reviewPrompt).not.toContain("## summarize");
  });

  it("captures model thinking, which appears nowhere in the sealed output", async () => {
    const { result } = await run([
      { kind: "content", content: REACTION(true), thinking: "Weighing whether this is for me." },
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    const thinking = await read(result.session.traceDir, "react.thinking.txt");
    expect(thinking).toContain("Weighing whether this is for me.");

    const meta = JSON.parse(await read(result.session.traceDir, "react.meta.json"));
    expect(meta.thinkingChars).toBeGreaterThan(0);

    // It is reasoning, not output — it must not leak into the sealed step file.
    expect(await read(result.session.dir, "reaction.md")).not.toContain("Weighing whether");
  });

  it("lets a step override its role's thinking setting", async () => {
    const { server } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);

    // `reasoning` leaves thinking to the model default; [steps.respond] turns it
    // off, because writing a reply from finished work does not need it.
    expect(server.requests[1]?.body.think).toBe(false);
  });

  it("answers a message that names the agent without a react model call", async () => {
    // Only respond and review are queued: being named settles the decision, and
    // with no selectable steps there is nothing left for react to choose.
    const { result, server } = await run(
      [reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: [] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");
    expect(server.requests.map((r) => r.body.model)).toEqual(["test-reasoning", "test-digest"]);

    // The step is still sealed and traced like any other.
    expect(await read(result.session.dir, "reaction.md")).toContain("Addressed by name");
    const meta = JSON.parse(await read(result.session.traceDir, "react.meta.json"));
    expect(meta.model).toBeNull();
    expect(meta.parsed.respond).toBe(true);
  });

  it("skips react even when steps remain to be chosen — schedule chooses them", async () => {
    // The whole point of splitting react and schedule: being named settles the
    // reply, so no model decides that again, and structuring is asked
    // separately. Only plan, respond, and review reach the model.
    const { result, server } = await run(
      [reply(SCHEDULE), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: ["research"] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "schedule",
      "respond",
      "summarize",
      "review",
    ]);
    expect(server.requests.map((r) => r.body.model)).toEqual([
      "test-fast", // schedule
      "test-reasoning", // respond
      "test-digest", // review
    ]);
    expect(await read(result.session.dir, "reaction.md")).toContain("Addressed by name");
  });

  it("runs the steps schedule chose, in order, before responding", async () => {
    const chosen = JSON.stringify({
      reason: "needs looking up then thinking about",
      needs_fact: true,
      needs_thought: true,
      steps: [
        { step: "research", topic: "find the version" },
        { step: "reason", topic: "work out the implication" },
      ],
    });
    const RESEARCH = JSON.stringify({ findings: "Node 22.", gaps: [] });
    const THOUGHTS = JSON.stringify({ thinking: "…", conclusion: "22 it is", uncertainties: [] });

    const { result } = await run(
      [reply(chosen), reply(RESEARCH), reply(THOUGHTS), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({
        ...c,
        session: { ...c.session, selectable_steps: ["research", "reason", "draft"] },
        // No tool loop: this test is about queue order, not tool calling.
        steps: { ...c.steps, research: { ...c.steps["research"], tools: [] } },
      }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "schedule",
      "research",
      "reason",
      "respond",
      "summarize",
      "review",
    ]);
    expect(await read(result.session.dir, "research.md")).toContain("Node 22.");
    expect(await read(result.session.dir, "thoughts.md")).toContain("22 it is");
  });

  it("still asks the model when the agent is not named", async () => {
    const { server } = await run(
      [reply(REACTION(false)), reply(REVIEW)],
      testMessage({ text: "@dana can you take a look at the deploy?" }),
    );

    expect(server.requests[0]?.body.model).toBe("test-fast");
    // The prompt states the mention verdict as settled fact.
    expect(server.requests[0]?.body.messages?.[0]?.content).toContain(
      "does not name the assistant",
    );
  });

  it("hands the reply over before the closing steps run", async () => {
    const seen: { text: string; completedSoFar: number }[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onReply: async (text) => {
        // Requests so far: react and respond. `review` has not been asked for
        // yet — which is the point: the person is not waiting on retrospection.
        seen.push({ text, completedSoFar: server.requests.length });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("Node 22 or newer.");
    expect(seen[0]?.completedSoFar).toBe(2);

    // ...and the closing steps still run afterwards, making three in total.
    expect(server.requests).toHaveLength(3);
    expect(result.completed.map((s) => s.name)).toContain("review");
  });

  it("cuts the session short when the budget runs out, but still answers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = JSON.stringify({
      reason: "lots to do",
      steps: [
        { step: "research", topic: "a" },
        { step: "reason", topic: "b" },
        { step: "draft", topic: "c" },
      ],
    });
    const RESEARCH = JSON.stringify({ findings: "…", gaps: [] });

    const { result } = await run(
      [reply(chosen), reply(RESEARCH), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, dig into this" }),
      (c) => ({
        ...c,
        session: {
          ...c.session,
          selectable_steps: ["research", "reason", "draft"],
          // Enough for plan and research, then nothing.
          max_model_calls: 2,
        },
        steps: { ...c.steps, research: { ...c.steps["research"], tools: [] } },
      }),
    );
    warn.mockRestore();

    // `reason` and `draft` were dropped, but the promised reply was still written.
    const names = result.completed.map((s) => s.name);
    expect(names).not.toContain("reason");
    expect(names).not.toContain("draft");
    expect(names).toContain("respond");
    expect(result.reply).toBe("Node 22 or newer.");
    expect(result.budgetStop).toContain("model calls");
  });

  it("re-schedules the rest of the session when the supervisor says adjust", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const SCHEDULED = JSON.stringify({
      reason: "look it up first",
      needs_fact: true,
      needs_thought: false,
      steps: [{ step: "research", topic: "find it" }],
    });
    const RESEARCH = JSON.stringify({ findings: "Node 22.", gaps: [] });
    const ADJUSTED = JSON.stringify({
      reason: "the question changed; think rather than look further",
      finished: false,
      // The booleans sit between `finished` and `steps`: once the step decides
      // to add work it otherwise reaches for `research` whatever the gap is.
      needs_fact: false,
      needs_thought: true,
      steps: [{ step: "reason", topic: "work out the implication" }],
    });
    const THOUGHTS = JSON.stringify({ thinking: "…", conclusion: "…", uncertainties: [] });

    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      reply(SCHEDULED),
      reply(RESEARCH),
      reply(JSON.stringify({ reason: "the ask has narrowed", verdict: "adjust" })),
      reply(ADJUSTED),
      reply(THOUGHTS),
      reply(RESPONSE),
      reply(REVIEW),
      reply(DEBRIEF),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = {
      ...base,
      session: { ...base.session, selectable_steps: ["research", "reason", "draft"] },
      steps: { ...base.steps, research: { ...base.steps["research"], tools: [] } },
    };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ text: "harness, what node version does this target?" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      // Arrives while `research` is running, not before: the supervisor is
      // asked once per arrival, at the first step boundary that sees it.
      pending: (() => {
        let seen = 0;
        return () =>
          ++seen > 2 ? [testMessage({ id: "m2", text: "actually, why that one?" })] : [];
      })(),
    });
    warn.mockRestore();

    // research ran, the supervisor re-scheduled, and `reason` replaced what
    // would otherwise have gone straight to the reply.
    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "schedule",
      "research",
      "adjust",
      "reason",
      "respond",
      "summarize",
      "review",
      // Something arrived mid-session, so the session closes by looking back at
      // how it handled that — the only feedback a supervisor verdict ever gets.
      "debrief",
    ]);
    expect(result.supervisorVerdicts).toEqual([{ step: "research", verdict: "adjust" }]);
    expect(await read(result.session.dir, "adjust.md")).toContain("reason");

    // The debrief sees what was said and what was decided about it; neither is
    // in `recent_messages`, which was read before the message arrived.
    const debriefPrompt = server.requests[7]?.body.messages?.[0]?.content ?? "";
    expect(debriefPrompt).toContain("actually, why that one?");
    expect(debriefPrompt).toContain("adjust");
  });

  it("runs respond with the knowledge tools it ships with", async () => {
    // The fixture strips these so mechanics tests can count their calls; this
    // is the one place the shipped configuration is exercised. Without it,
    // turning tools on in `config/default.toml` would be untested everywhere.
    const { result, server } = await run(
      [
        reply(REACTION(true)),
        // The loop: ask for a tool, then answer without one to end it, then a
        // final schema-shaped call over the transcript of what came back.
        toolCall("knowledge_search", { query: "node version" }),
        reply("Nothing in the store about this."),
        reply(RESPONSE),
        reply(REVIEW),
      ],
      testMessage(),
      (c) => ({
        ...c,
        steps: {
          ...c.steps,
          respond: { ...c.steps["respond"], tools: ["knowledge_search", "knowledge_read"] },
        },
      }),
    );

    expect(result.reply).toBe("Node 22 or newer.");
    // Gather first, unconstrained, then answer under the schema over what came
    // back: constrained decoding and tool calling cannot both be in force.
    expect(server.requests).toHaveLength(5);
    expect(server.requests[1]?.body.tools?.length).toBeGreaterThan(0);
    expect(server.requests[1]?.body.format).toBeUndefined();
    expect(server.requests[3]?.body.format).toBeDefined();
    expect(server.requests[3]?.body.tools).toBeUndefined();
    expect(server.requests[3]?.body.messages?.[0]?.content).toContain("What the tools returned");
  });

  it("numbers sessions monotonically", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    // The second session finds a prior one in this channel, so it opens with
    // `reflect` — an extra call the first session does not make.
    const server = await mockOllama([
      reply(REACTION(false)),
      reply(REVIEW),
      reply(REFLECTION),
      reply(REACTION(false)),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const base = {
      config,
      paths,
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    };
    const first = await runSession({ ...base, trigger: messageTrigger(testMessage({ id: "a" })) });
    const second = await runSession({ ...base, trigger: messageTrigger(testMessage({ id: "b" })) });

    expect(first.session.number).toBe(1);
    expect(second.session.number).toBe(2);
    expect(second.session.id.startsWith("000002-")).toBe(true);

    // Nothing to reflect on in a fresh channel; plenty in the second session.
    expect(first.completed.map((s) => s.name)).not.toContain("reflect");
    expect(second.completed.map((s) => s.name)[0]).toBe("reflect");
  });
});
