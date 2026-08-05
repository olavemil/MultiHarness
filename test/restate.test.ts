import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../src/session/run.ts";
import { maintenanceTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { restate } from "../src/steps/restate.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import type { PriorSession } from "../src/store/priorSession.ts";
import { mockOllama, reply, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
} from "./helpers/fixtures.ts";

/**
 * The restated request: one call per session turning the incoming message into
 * a self-contained statement of the task, so that later steps are not each
 * inferring it from the transcript separately and differently.
 */

const REACTION = (respond: boolean) =>
  JSON.stringify({ reason: respond ? "asked me directly" : "aimed at someone else", respond });
const REQUEST = JSON.stringify({
  reasoning: "\"it\" refers to the import script two messages back.",
  request: "Sketch an approach for the CSV import script, in TypeScript.",
  resolved: true,
  unresolved: [],
});
const RESPONSE = JSON.stringify({ message: "Node 22 or newer." });
const REVIEW = JSON.stringify({ assessment: "Answered directly.", quality: 4, recommendations: [] });

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function run(
  replies: MockReply[],
  opts: {
    message?: ReturnType<typeof testMessage>;
    history?: ReturnType<typeof testHistory>;
    prior?: PriorSession;
    tweak?: (c: Config) => Config;
  } = {},
) {
  const { dir, cleanup } = await tempWorkingDir();
  const server: MockOllama = await mockOllama(replies);
  cleanups.push(cleanup, server.close);

  const base = await testConfig(server.host, dir);
  // The fixture turns it off for the pipeline-mechanics tests; this file is
  // what turns it back on.
  const withRestate: Config = {
    ...base,
    session: { ...base.session, restate_step: "restate" },
  };
  const config = opts.tweak ? opts.tweak(withRestate) : withRestate;

  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const result = await runSession({
    config,
    paths,
    trigger: messageTrigger(opts.message ?? testMessage()),
    identity: testIdentity(),
    history: opts.history ?? testHistory(),
    prior: opts.prior,
    rng: () => 0,
  });

  return { result, server };
}

const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");

describe("restate", () => {
  it("runs between the reply decision and the work, sealed as request.md", async () => {
    const { result } = await run([reply(REACTION(true)), reply(REQUEST), reply(RESPONSE), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "restate",
      "respond",
      "summarize",
      "review",
    ]);
    expect(await read(result.session.dir, "request.md")).toContain(
      "Sketch an approach for the CSV import script",
    );
  });

  it("gives the reply step the restatement alongside the literal message", async () => {
    // Both, deliberately: the gap between them is the signal, and a step handed
    // only the polished version cannot see that anything was inferred.
    const { server } = await run([
      reply(REACTION(true)),
      reply(REQUEST),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    const respondPrompt = server.requests[2]?.body.messages?.[0]?.content ?? "";
    expect(respondPrompt).toContain("Sketch an approach for the CSV import script");
    expect(respondPrompt).toContain("what version of node is this project on?");
  });

  it("is skipped on the declining path, which is the common one", async () => {
    const { result } = await run([reply(REACTION(false)), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual(["react", "summarize", "review"]);
    await expect(read(result.session.dir, "request.md")).rejects.toThrowError();
  });

  it("is skipped when there is no history to boil down", async () => {
    // A first message in a channel is already self-contained; there is nothing
    // for a restatement to resolve.
    const { result } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)], {
      history: [],
    });

    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "respond",
      "summarize",
      "review",
    ]);
  });

  it("is skipped when the step is configured empty", async () => {
    const { result } = await run([reply(REACTION(true)), reply(RESPONSE), reply(REVIEW)], {
      tweak: (c) => ({ ...c, session: { ...c.session, restate_step: "" } }),
    });

    expect(result.completed.map((s) => s.name)).not.toContain("restate");
  });

  it("runs before schedule, so the choice of steps sees the restated task", async () => {
    const SCHEDULE = JSON.stringify({
      reason: "answer directly",
      needs_fact: false,
      needs_thought: false,
      steps: [],
    });

    const { result, server } = await run(
      [reply(REQUEST), reply(SCHEDULE), reply(RESPONSE), reply(REVIEW)],
      {
        message: testMessage({ text: "harness, could you sketch out how you'd do it?" }),
        tweak: (c) => ({ ...c, session: { ...c.session, selectable_steps: ["research"] } }),
      },
    );

    // Named, so `react` never calls a model; `restate` is the first call made.
    expect(result.completed.map((s) => s.name)).toEqual([
      "react",
      "restate",
      "schedule",
      "respond",
      "summarize",
      "review",
    ]);
    const schedulePrompt = server.requests[1]?.body.messages?.[0]?.content ?? "";
    expect(schedulePrompt).toContain("Sketch an approach for the CSV import script");
  });

  it("degrades to the message itself when the restatement cannot be parsed", async () => {
    // The documented safe default: an empty request means downstream steps read
    // the message as written, which is what they did before this step existed.
    // `resolved` stays true — claiming ambiguity with nothing to name would push
    // `respond` into asking a clarifying question about nothing.
    const { result, server } = await run([
      reply(REACTION(true)),
      reply("not json"),
      reply("still not json"),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    expect(await read(result.session.dir, "request.md")).toContain("read it as written");
    const respondPrompt = server.requests[3]?.body.messages?.[0]?.content ?? "";
    expect(respondPrompt).toContain("read it as written");
    expect(result.reply).toBe("Node 22 or newer.");
  });

  it("carries reflect's correction into the restatement, and the previous reading into reflect", async () => {
    // The recovery path for the ambiguity failure. `restate` cannot tell two
    // candidate referents apart up front, but the person says which one they
    // meant, and `reflect` is the only step positioned to see that.
    const prior: PriorSession = {
      id: "000001-prior",
      number: 1,
      review: "# Review\n\n**Quality:** 4/5\n\nPlanned the scheduler rewrite.",
      summary: "# Session summary",
      reflection: "",
      request: "# Request, restated\n\nDraft a plan for the scheduler rewrite.",
      debrief: "",
    };
    const REFLECTION = JSON.stringify({
      assessment: "They say the answer covered the wrong one of the two proposals.",
      signal: "dissatisfied",
      correction: "They want a plan for moving the worker pool, not the scheduler rewrite.",
      recommendations: [],
      impression: "",
    });

    const { server } = await run(
      [reply(REFLECTION), reply(REACTION(true)), reply(REQUEST), reply(RESPONSE), reply(REVIEW)],
      { prior },
    );

    // reflect sees how the last session read the question...
    const reflectPrompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(reflectPrompt).toContain("Draft a plan for the scheduler rewrite");

    // ...and its correction reaches restate, which runs two steps later.
    const restatePrompt = server.requests[2]?.body.messages?.[0]?.content ?? "";
    expect(restatePrompt).toContain("moving the worker pool");
  });

  it("tells restate plainly when no correction was made", async () => {
    // Empty is the common case and must not read as a missing variable. An
    // invented correction is worse than an invented critique: the session's
    // whole understanding of the question is built from it.
    const { server } = await run([
      reply(REACTION(true)),
      reply(REQUEST),
      reply(RESPONSE),
      reply(REVIEW),
    ]);

    const restatePrompt = server.requests[1]?.body.messages?.[0]?.content ?? "";
    expect(restatePrompt).toContain("no correction");
    expect(restatePrompt).not.toContain("${");
  });

  it("decides settledness before writing the restatement it would otherwise judge", async () => {
    // Constrained decoding emits keys in schema order, and this order was
    // measured: with `request` first, `resolved` came back true on 6 of 6 runs
    // across two genuinely ambiguous cases.
    const { properties } = (await import("zod")).z.toJSONSchema(
      restate.buildSchema({} as Config),
    ) as { properties: Record<string, unknown> };

    expect(Object.keys(properties)).toEqual(["reasoning", "resolved", "unresolved", "request"]);
  });
});
