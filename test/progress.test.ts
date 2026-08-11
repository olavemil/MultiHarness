import { afterEach, describe, expect, it } from "vitest";
import { describeStep, describeToolUse } from "../src/session/progress.ts";
import { messageTrigger } from "../src/core/trigger.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, toolCall, type MockOllama } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
} from "./helpers/fixtures.ts";
import type { Config } from "../src/config/schema.ts";
import type { ToolCallRecord } from "../src/tools/types.ts";

/**
 * What a session says about itself while it runs.
 *
 * A session is a sequence of steps each taking tens of seconds, and the only
 * thing it used to say was "thinking" — so a long wait and a stuck daemon were
 * indistinguishable, and the reply gave no hint of what it had cost.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const call = (name: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  name,
  args: {},
  result: "…",
  durationMs: 1,
  ...over,
});

describe("describing a step", () => {
  it("names what it is doing, not what it is called", () => {
    expect(describeStep("reflect")).toBe("reflecting");
    expect(describeStep("research")).toBe("researching");
    expect(describeStep("update")).toBe("checking what just arrived");
  });

  it("falls back to the step name rather than throwing", () => {
    // A new step must not be able to break the log on its first run.
    expect(describeStep("brand_new_step")).toBe("brand_new_step");
  });
});

describe("describing what a step touched", () => {
  it("says nothing when no tools were used", () => {
    // Most steps use none, and a line saying so every time would bury the ones
    // that did.
    expect(describeToolUse([])).toBeUndefined();
  });

  it("groups reads and writes into what a person would call them", () => {
    expect(
      describeToolUse([call("knowledge_read"), call("knowledge_search"), call("file_write")]),
    ).toBe("2 memories read, 1 file written");
  });

  it("counts a single one in the singular", () => {
    expect(describeToolUse([call("wikipedia_search")])).toBe("1 article read");
    expect(describeToolUse([call("knowledge_write")])).toBe("1 memory written");
  });

  it("keeps reads and writes to the same store apart", () => {
    expect(describeToolUse([call("knowledge_read"), call("knowledge_write")])).toBe(
      "1 memory read, 1 memory written",
    );
  });

  it("does not report a failed call as a read", () => {
    // A tool that threw did not read anything, and counting it as a read would
    // overstate what the step actually saw.
    expect(describeToolUse([call("knowledge_read"), call("file_read", { error: "nope" })])).toBe(
      "1 memory read, 1 failed",
    );
  });

  it("counts a tool it has no phrasing for rather than dropping it", () => {
    expect(describeToolUse([call("some_new_tool")])).toContain("some_new_tool");
  });
});

describe("a session narrating itself", () => {
  it("announces each step, and what the step touched", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(JSON.stringify({ reason: "asked me", verdict: "reply", interest: 0.9 })),
      // `respond` ships with knowledge tools, so it runs a tool loop first: ask
      // for a tool, then answer without one to end the loop, then the final
      // schema-shaped call over the transcript.
      toolCall("knowledge_search", { query: "node" }),
      reply("Nothing in the store about this."),
      reply(JSON.stringify({ message: "Node 22 or newer." })),
      reply(JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] })),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    // The fixture strips tool allowlists; this is the path that has them.
    const config = {
      ...base,
      steps: {
        ...base.steps,
        respond: { ...base.steps["respond"], tools: ["knowledge_search"] },
      },
    } as Config;
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const notes: string[] = [];
    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onProgress: (note) => notes.push(note),
    });

    // Each step announces itself, in order, as it starts. The line carries the
    // step's topic after it, so the assertion is on the leading verb rather
    // than on the whole string — the topic is chosen by a model and is not the
    // thing under test here.
    const at = (verb: string) => notes.findIndex((n) => n.startsWith(verb));
    expect(at("reacting")).toBeGreaterThanOrEqual(0);
    expect(at("responding")).toBeGreaterThanOrEqual(0);
    expect(at("reviewing")).toBeGreaterThanOrEqual(0);
    expect(at("reacting")).toBeLessThan(at("responding"));

    // And the step that used a tool says so, after it.
    expect(notes).toContain("1 memory read");
    expect(at("responding")).toBeLessThan(notes.indexOf("1 memory read"));
  });
});
