import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession } from "../src/session/run.ts";
import { maintenanceTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, toolCall, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
  entryReplies,
  promptFor,
} from "./helpers/fixtures.ts";

const SCHEDULE = JSON.stringify({
  reason: "answer directly",
  needs_fact: false,
  needs_thought: false,
  steps: [],
  reaction: "eyes",
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
  it("runs read -> stance -> respond -> summarize -> review and seals every output", async () => {
    const { result } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");

    for (const file of ["reading.md", "stance.md", "response.md", "summary.md", "review.md"]) {
      await expect(read(result.session.dir, file)).resolves.toBeTruthy();
    }
  });

  it("makes sealed output read-only on disk, not merely by convention", async () => {
    const { result } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
    const target = path.join(result.session.dir, "response.md");

    expect((await stat(target)).mode & 0o777).toBe(0o444);
    await expect(writeFile(target, "tampered", "utf8")).rejects.toThrowError();
  });

  it("records the prompt variant, model, and rendered prompt in the trace", async () => {
    const { result } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
    const meta = JSON.parse(await read(result.session.traceDir, "stance.meta.json"));

    expect(meta.variantId).toBe("stance_1");
    expect(meta.model).toBe("test-fast");
    expect(meta.role).toBe("fast");
    expect(meta.fellBack).toBe(false);
    // The message is mandatory and inline; everything else is an appendix, and
    // an appendix that resolved to nothing is not listed because it was not
    // there — no heading, no placeholder, no budget spent.
    expect(meta.contextBlocks.map((b: { name: string }) => b.name)).toEqual([
      "incoming_message",
      "recent_messages",
    ]);

    // The prompt actually sent is reproducible from the trace alone.
    const prompt = await read(result.session.traceDir, "stance.prompt.md");
    expect(prompt).toContain("what version of node is this project on?");
    expect(prompt).not.toContain("${");
    await expect(read(result.session.traceDir, "stance.raw.txt")).resolves.toContain("interest");
  });

  it("routes each step to the model role its config assigns", async () => {
    const { server } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);

    expect(server.requests.map((r) => r.body.model)).toEqual([
      "test-fast", // read
      "test-fast", // stance
      "test-reasoning", // respond
      "test-digest", // review
    ]);
    // `digest` reuses the reasoning weights with thinking off.
    expect(server.requests[3]?.body.think).toBe(false);
  });

  it("skips straight to the closing steps when the entry steps decline to respond", async () => {
    const { result, server } = await run([...entryReplies(false).map(reply), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual(["read", "stance", "summarize", "review"]);
    expect(result.reply).toBeUndefined();
    expect(server.requests).toHaveLength(3);

    await expect(read(result.session.dir, "response.md")).rejects.toThrowError();
    // The verdict is derived rather than decoded, so it is not any one step's
    // sealed output — it is returned, and traced beside every input it rests on.
    expect(result.decision?.verdict).toBe("for_someone_else");
    expect(await read(result.session.dir, "reading.md")).toContain("**Wants:** nothing");
  });

  it("completes the session on a documented default when a step cannot be parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await run([
      reply("not json"),
      reply("still not json"),
      reply(entryReplies(true)[1] as string),
      reply(RESPONSE),
      reply(REVIEW),
    ]);
    warn.mockRestore();

    // `read` fell back to "an answer is wanted", so the pipeline continued
    // intact. A parse failure is a harness problem, and going quiet over one
    // looks exactly like being ignored to the person waiting.
    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");

    const meta = JSON.parse(await read(result.session.traceDir, "read.meta.json"));
    expect(meta.fellBack).toBe(true);
    expect(meta.attempts).toBe(2);
    expect(meta.validationErrors).toHaveLength(2);

    // And the fallback is visible in the sealed output and the summary.
    expect(await read(result.session.dir, "reading.md")).toContain("could not be parsed");
    expect(await read(result.session.dir, "summary.md")).toContain("fell back to default");
  });

  it("feeds later steps the output of earlier ones", async () => {
    const { server } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
    const reviewPrompt = server.requests[3]?.body.messages?.[0]?.content ?? "";

    // review judges the quality of the reply, so it has to be able to see it.
    // Without this the step rates every session against a timing table alone.
    expect(reviewPrompt).toContain("Node 22 or newer.");

    // ...alongside the structural record of what ran.
    expect(reviewPrompt).toContain("Session summary");
    expect(reviewPrompt).toContain("| read |");
  });

  it("keeps bookkeeping steps out of prior_step_output", async () => {
    const { server } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
    const reviewPrompt = server.requests[3]?.body.messages?.[0]?.content ?? "";

    // The entry steps' routing decisions and summarize's table are not work
    // product; the summary appears once, under its own heading, not duplicated
    // as output.
    expect(reviewPrompt).not.toContain("### read");
    expect(reviewPrompt).not.toContain("### stance");
    expect(reviewPrompt).not.toContain("### summarize");
  });

  it("captures model thinking, which appears nowhere in the sealed output", async () => {
    const { result } = await run([
      {
        kind: "content",
        content: entryReplies(true)[0] as string,
        thinking: "Weighing whether this is for me.",
      },
      reply(entryReplies(true)[1] as string),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    const thinking = await read(result.session.traceDir, "read.thinking.txt");
    expect(thinking).toContain("Weighing whether this is for me.");

    const meta = JSON.parse(await read(result.session.traceDir, "read.meta.json"));
    expect(meta.thinkingChars).toBeGreaterThan(0);

    // It is reasoning, not output — it must not leak into the sealed step file.
    expect(await read(result.session.dir, "reading.md")).not.toContain("Weighing whether");
  });

  it("lets a step override its role's thinking setting", async () => {
    const { server } = await run([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);

    // `reasoning` leaves thinking to the model default; [steps.respond] turns it
    // off, because writing a reply from finished work does not need it.
    expect(server.requests[2]?.body.think).toBe(false);
  });

  it("still reads a message that names the agent, rather than answering it blind", async () => {
    // Being named used to skip both entry steps outright. That is what produced
    // the mention loop: with no reading and a fabricated `interest` of 1,
    // nothing could tell `@harness good point` from a question, and being named
    // disables every damping term there is. Both steps run now, and the cost is
    // two `fast` calls on the path that used to be free.
    const { result, server } = await run(
      [...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: [] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");
    expect(server.requests.map((r) => r.body.model)).toEqual([
      "test-fast",
      "test-fast",
      "test-reasoning",
      "test-digest",
    ]);
    expect(result.decision?.verdict).toBe("reply");
  });

  it("records how long each step waited for a model", async () => {
    // The field was missing from the trace entirely, so every session read
    // `waitedMs: 0` — the absence of a measurement, not a measurement of zero.
    // That is unfalsifiable from the outside and it misled three separate
    // investigations into contention, so its presence is asserted rather than
    // assumed. `durationMs` includes it; the difference is time on the weights.
    const { result } = await run(
      [...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)],
      testMessage(),
    );

    for (const step of ["read", "stance", "respond"]) {
      const meta = JSON.parse(await read(result.session.traceDir, `${step}.meta.json`));
      expect(meta, `${step} should report queued time`).toHaveProperty("waitedMs");
      expect(typeof meta.waitedMs).toBe("number");
    }
  });

  it("reads a named message even when steps remain to be chosen — schedule chooses them", async () => {
    // The point of splitting the reply decision from structuring: being named
    // settles that the message is not ignored, and `schedule` is asked
    // separately what work it needs.
    const { result, server } = await run(
      [...entryReplies(true).map(reply), reply(SCHEDULE), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: ["research"] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "schedule",
      "respond",
      "summarize",
      "review",
    ]);
    expect(server.requests.map((r) => r.body.model)).toEqual([
      "test-fast", // read
      "test-fast", // stance
      "test-fast", // schedule
      "test-reasoning", // respond
      "test-digest", // review
    ]);
    // `stance` is a real call now, so its output is a real judgement rather
    // than a note that the harness matched a name.
    expect(await read(result.session.dir, "stance.md")).toContain("Interest:");
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
      reaction: "eyes",
    });
    const RESEARCH = JSON.stringify({ findings: "Node 22.", gaps: [] });
    const THOUGHTS = JSON.stringify({ thinking: "…", conclusion: "22 it is", uncertainties: [] });

    const { result } = await run(
      [
        ...entryReplies(true).map(reply),
        reply(chosen),
        reply(RESEARCH),
        reply(THOUGHTS),
        reply(RESPONSE),
        reply(REVIEW),
      ],
      testMessage({ text: "harness, what node version does this project target?" }),
      (c) => ({
        ...c,
        session: { ...c.session, selectable_steps: ["research", "reason", "draft"] },
        // No tool loop: this test is about queue order, not tool calling.
        steps: { ...c.steps, research: { ...c.steps["research"], tools: [] } },
      }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
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

  it("for acknowledgement messages, runs schedule but skips respond when interest is low", async () => {
    const ACK_READ = JSON.stringify({
      reason: "A status check that can be acknowledged.",
      target: "m1",
      addressee: "agent",
      wants: "acknowledgement",
    });
    const ACK_STANCE_LOW = JSON.stringify({
      reason: "Nothing useful to add beyond a mark.",
      interest: 0,
      reaction: "white_check_mark",
    });
    const ACK_SCHEDULE = JSON.stringify({
      reason: "No prep work needed.",
      needs_fact: false,
      needs_thought: false,
      steps: [],
      reaction: "eyes",
    });

    const { result } = await run(
      [reply(ACK_READ), reply(ACK_STANCE_LOW), reply(ACK_SCHEDULE), reply(REVIEW)],
      testMessage({ text: "Did you send it yet?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: ["research"] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "schedule",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBeUndefined();
  });

  it("for acknowledgement messages, runs schedule and responds when interest is high", async () => {
    const ACK_READ = JSON.stringify({
      reason: "A status check that can be acknowledged.",
      target: "m1",
      addressee: "agent",
      wants: "acknowledgement",
    });
    const ACK_STANCE_HIGH = JSON.stringify({
      reason: "There is useful clarification to add.",
      interest: 1,
      reaction: "white_check_mark",
    });
    const ACK_SCHEDULE = JSON.stringify({
      reason: "No prep work needed.",
      needs_fact: false,
      needs_thought: false,
      steps: [],
      reaction: "eyes",
    });

    const { result } = await run(
      [reply(ACK_READ), reply(ACK_STANCE_HIGH), reply(ACK_SCHEDULE), reply(RESPONSE), reply(REVIEW)],
      testMessage({ text: "Did you send it yet?" }),
      (c) => ({ ...c, session: { ...c.session, selectable_steps: ["research"] } }),
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "schedule",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.reply).toBe("Node 22 or newer.");
  });

  it("can run initiate from schedule in a message session and target a DM by name", async () => {
    const SCHEDULE_INITIATE = JSON.stringify({
      reason: "send one follow-up while replying",
      needs_fact: false,
      needs_thought: false,
      steps: [{ step: "initiate", topic: "follow up with dana about the migration version" }],
      reaction: "eyes",
    });
    const INITIATE = JSON.stringify({
      reasoning: "dana is the one waiting on this correction",
      targets: [{ target: "dm:dana", intent: "their migration assumption used the wrong version" }],
    });
    const OUTREACH = JSON.stringify({
      message: "Quick heads-up: that migration note assumes the wrong version.",
    });

    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      ...entryReplies(true).map(reply),
      reply(SCHEDULE_INITIATE),
      reply(INITIATE),
      reply(OUTREACH),
      reply(RESPONSE),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const loadTargets = vi.fn(async () => [
      {
        ref: "dm:dana",
        kind: "dm" as const,
        id: "dana",
        name: "dana",
        silentMs: 2 * 3_600_000,
        agentHasSpoken: true,
        messagesSinceAgentSpoke: 0,
      },
    ]);

    const result = await runSession({
      config: {
        ...config,
        session: { ...config.session, selectable_steps: ["initiate"] },
      },
      paths,
      trigger: messageTrigger(testMessage({ text: "harness, what node version does this use?" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      loadInitiativeTargets: loadTargets,
    });

    expect(loadTargets).toHaveBeenCalledTimes(1);
    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "schedule",
      "initiate",
      "outreach",
      "respond",
      "summarize",
      "review",
    ]);
    expect(result.initiatives).toEqual([
      {
        ref: "dm:dana",
        kind: "dm",
        id: "dana",
        name: "dana",
        message: "Quick heads-up: that migration note assumes the wrong version.",
      },
    ]);
  });

  it("still asks the model when the agent is not named", async () => {
    const { server } = await run(
      [...entryReplies(false).map(reply), reply(REVIEW)],
      testMessage({ text: "@dana can you take a look at the deploy?" }),
    );

    expect(server.requests[0]?.body.model).toBe("test-fast");

    // And says nothing about mentions while doing it. Being named is matched in
    // code and decides the reply without the model's help, so stating "the
    // message does not name the agent" only teaches it to go looking for
    // mentions on every message it sees. When the agent *is* named, the
    // `named.md` situation fragment says so — where it is load-bearing.
    const prompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(prompt).not.toContain("does not name the agent");
    expect(prompt).not.toContain("Whether the agent was named");
    // The transcript and the question it has to answer are still there.
    expect(prompt).toContain("@dana can you take a look at the deploy?");
  });

  it("hands the reply over before the closing steps run", async () => {
    const seen: { text: string; completedSoFar: number }[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)]);
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
        // Requests so far: read, stance, and respond. `review` has not been
        // asked for yet — which is the point: the person is not waiting on
        // retrospection.
        seen.push({ text, completedSoFar: server.requests.length });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("Node 22 or newer.");
    expect(seen[0]?.completedSoFar).toBe(3);

    // ...and the closing steps still run afterwards, making four in total.
    expect(server.requests).toHaveLength(4);
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

  it("gives the promised reply real time when the wallclock ran out", async () => {
    // The branch above exhausts on *model calls*, where `remainingMs` is still
    // large — so this case needs wallclock exhaustion specifically. `respond`
    // used to be clamped to whatever the exhausted budget had left and failed on
    // its own deadline, so the branch that exists to make sure somebody gets an
    // answer guaranteed that nobody did — seen live as `respond` "timed out
    // after 1000ms". Fixed at the root in `session/budget.ts`: `respond`, like
    // every non-selectable step, now always runs at its own full configured
    // timeout regardless of the session's remaining wallclock.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, cleanup } = await tempWorkingDir();
    // Each call burns 1.2s and the budget is 1s, so `read` alone *overspends*
    // it — which is the real shape: the live failure had `research` and `reason`
    // run for minutes, leaving `remainingMs` at zero. A budget merely *tight*
    // would not reproduce it, because the clamp still yields a workable timeout.
    const server: MockOllama = await mockOllama(
      [...entryReplies(true).map(reply), reply(RESPONSE), reply(REVIEW)],
      { delayMs: 1_200 },
    );
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = {
      ...base,
      session: { ...base.session, max_wallclock_ms: 1_000 },
    } as Config;
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    });
    warn.mockRestore();

    expect(result.budgetStop).toContain("wallclock");
    // The whole point: it was late, and it answered anyway.
    expect(result.reply).toBe("Node 22 or newer.");
    expect(result.completed.map((s) => s.name)).toContain("respond");
  });

  it("re-schedules the rest of the session when the supervisor says adjust", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const SCHEDULED = JSON.stringify({
      reason: "look it up first",
      needs_fact: true,
      needs_thought: false,
      steps: [{ step: "research", topic: "find it" }],
      reaction: "eyes",
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
      reaction: "eyes",
    });
    const THOUGHTS = JSON.stringify({ thinking: "…", conclusion: "…", uncertainties: [] });

    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      ...entryReplies(true).map(reply),
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
      // asked once per arrival, at the first step boundary that sees it. The
      // count is step iterations — read, stance, schedule, then research — so
      // it moves whenever the number of steps before `research` does.
      pending: (() => {
        let seen = 0;
        return () =>
          ++seen > 3 ? [testMessage({ id: "m2", text: "actually, why that one?" })] : [];
      })(),
    });
    warn.mockRestore();

    // research ran, the supervisor re-scheduled, and `reason` replaced what
    // would otherwise have gone straight to the reply.
    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
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
    const debriefPrompt = promptFor(server, "debrief");
    expect(debriefPrompt).toContain("actually, why that one?");
    expect(debriefPrompt).toContain("adjust");
  });

  it("runs respond with the knowledge tools it ships with", async () => {
    // The fixture strips these so mechanics tests can count their calls; this
    // is the one place the shipped configuration is exercised. Without it,
    // turning tools on in `config/default.toml` would be untested everywhere.
    const { result, server } = await run(
      [
        ...entryReplies(true).map(reply),
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
    expect(server.requests).toHaveLength(6);
    expect(server.requests[2]?.body.tools?.length).toBeGreaterThan(0);
    expect(server.requests[2]?.body.format).toBeUndefined();
    expect(server.requests[4]?.body.format).toBeDefined();
    expect(server.requests[4]?.body.tools).toBeUndefined();
    expect(server.requests[4]?.body.messages?.[0]?.content).toContain("What the tools returned");
  });

  it("numbers sessions monotonically", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    // The second session finds a prior one in this channel, so it opens with
    // `reflect` — an extra call the first session does not make.
    const server = await mockOllama([
      ...entryReplies(false).map(reply),
      reply(REVIEW),
      reply(REFLECTION),
      ...entryReplies(false).map(reply),
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
