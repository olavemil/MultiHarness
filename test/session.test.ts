import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import { tempWorkingDir, testConfig, testHistory, testIdentity, testMessage } from "./helpers/fixtures.ts";

const REACTION = (respond: boolean) =>
  JSON.stringify({ respond, reason: respond ? "asked me directly" : "aimed at someone else", steps: [] });
const RESPONSE = JSON.stringify({ message: "Node 22 or newer." });
const REVIEW = JSON.stringify({ assessment: "Answered directly.", quality: 4, recommendations: [] });
const REFLECTION = JSON.stringify({
  assessment: "A new question; the previous answer was not commented on.",
  signal: "no_signal",
  recommendations: [],
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Runs one full session against a mocked model server. */
async function run(replies: MockReply[], message = testMessage()) {
  const { dir, cleanup } = await tempWorkingDir();
  const server: MockOllama = await mockOllama(replies);
  cleanups.push(cleanup, server.close);

  const config = await testConfig(server.host, dir);
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const result = await runSession({
    config,
    paths,
    message,
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
    const first = await runSession({ ...base, message: testMessage({ id: "a" }) });
    const second = await runSession({ ...base, message: testMessage({ id: "b" }) });

    expect(first.session.number).toBe(1);
    expect(second.session.number).toBe(2);
    expect(second.session.id.startsWith("000002-")).toBe(true);

    // Nothing to reflect on in a fresh channel; plenty in the second session.
    expect(first.completed.map((s) => s.name)).not.toContain("reflect");
    expect(second.completed.map((s) => s.name)[0]).toBe("reflect");
  });
});
