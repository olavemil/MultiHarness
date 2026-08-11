import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Config } from "../src/config/schema.ts";
import { messageTrigger } from "../src/core/trigger.ts";
import { callModel } from "../src/model/call.ts";
import { createDeadline } from "../src/model/deadline.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
} from "./helpers/fixtures.ts";

/**
 * Roadmap 1d: the three faults from `galatea/000007`, plus the missing failure
 * record. All four are about a session surviving something going wrong rather
 * than about the quality of its output.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

describe("sleep-aware deadlines", () => {
  it("does not charge suspended wallclock against the timeout", () => {
    vi.useFakeTimers();
    const deadline = createDeadline(10_000, 1_000);

    // Ordinary ticks are charged.
    vi.advanceTimersByTime(3_000);
    expect(deadline.signal.aborted).toBe(false);

    // The machine sleeps. Advancing the clock without running the intervening
    // timers is what suspension actually looks like: the ticks never happened,
    // and the one that follows arrives an hour late. `AbortSignal.timeout` would
    // have fired long ago and blamed the model.
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    vi.advanceTimersByTime(1_000);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.suspendedMs()).toBeGreaterThan(3_500_000);

    // And the remaining budget is still the real one.
    vi.advanceTimersByTime(6_000);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(deadline.signal.aborted).toBe(true);

    deadline.release();
  });

  it("still fires on a genuine timeout, as a TimeoutError", () => {
    vi.useFakeTimers();
    const deadline = createDeadline(2_000, 1_000);

    vi.advanceTimersByTime(3_000);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError");

    deadline.release();
  });
});

describe("salvaging a timed-out step", () => {
  const schema = z.object({ reason: z.string(), respond: z.boolean() });

  async function callAgainst(body: string, timeoutMs = 300) {
    // The mock streams its content and then holds the connection open, so the
    // deadline fires mid-stream with content already in hand — the shape a
    // thinking model actually produces.
    const server: MockOllama = await mockOllama([{ kind: "content", content: body, hang: true }]);
    cleanups.push(server.close);

    return callModel({
      label: "test",
      host: server.host,
      role: { name: "fast", model: "m", options: {}, noTools: false, exclusive: false },
      prompt: "p",
      schema,
      fallback: () => ({ reason: "fallback", respond: false }),
      timeoutMs,
    });
  }

  it("closes an object the model had not finished and uses it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A complete answer bar its closing brace: ten minutes of work that used to
    // be discarded over one character.
    const result = await callAgainst('{"reason":"asked directly","respond":true');
    warn.mockRestore();

    expect(result.value).toEqual({ reason: "asked directly", respond: true });
    expect(result.trace.fellBack).toBe(false);
    expect(result.trace.attempts.at(-1)?.salvagedFromTimeout).toBe(true);
  });

  it("closes an unterminated string as well as the brackets", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await callAgainst('{"respond":false,"reason":"aimed at someone els');
    warn.mockRestore();

    expect((result.value as { respond: boolean }).respond).toBe(false);
  });

  it("throws rather than inventing fields the model never produced", async () => {
    // Salvage only ever *adds closing delimiters*. A partial missing a required
    // field is not repairable, and guessing one would put fabricated output into
    // a sealed step.
    await expect(callAgainst('{"reason":"got this far')).rejects.toThrowError(/exceeded/);
  });

  it("reports suspension in the message rather than blaming the model", async () => {
    const server: MockOllama = await mockOllama([{ kind: "status", status: 500, body: "boom" }]);
    cleanups.push(server.close);

    await expect(
      callModel({
        label: "test",
        host: server.host,
        role: { name: "fast", model: "qwen3.6:27b", options: {}, noTools: false, exclusive: false },
        prompt: "p",
        schema,
        fallback: () => ({ reason: "fallback", respond: false }),
        timeoutMs: 1_000,
      }),
    ).rejects.toThrowError(/ollama returned 500/);
  });
});

describe("a failed step records why, in the session", () => {
  it("carries on to the next step when one runs out of time", async () => {
    // A slow `research` used to take the whole session down with it, throwing
    // away the reply somebody was waiting for. Its partial output survives in
    // the working file — which is the reason steps stream to one — so the
    // session can carry on from what it did gather.
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      reply(JSON.stringify({ reason: "asked me", verdict: "reply", interest: 0.9 })),
      // `respond` never finishes: content streams, then the connection hangs
      // until the deadline fires. Nothing to salvage into the schema.
      { kind: "content", content: "half an ans", hang: true },
      reply(JSON.stringify({ assessment: "ok", quality: 3, recommendations: [] })),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = {
      ...base,
      ollama: { ...base.ollama, request_timeout_ms: 700 },
    } as Config;
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const notes: string[] = [];
    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onProgress: (note) => notes.push(note),
    });

    // The session finished rather than throwing, and said so.
    expect(notes.some((n) => n.includes("ran out of time"))).toBe(true);
    // And the closing steps still ran, so the session left a record.
    expect(result.completed.map((s) => s.name)).toContain("review");
    // The dead step still sealed its own account of why.
    const { readFile } = await import("node:fs/promises");
    const failure = await readFile(path.join(result.session.dir, "failure.md"), "utf8");
    expect(failure).toContain("respond");
    // Slower than the other cases here on purpose: `MIN_STEP_MS` floors a step's
    // timeout at five seconds, so a genuine timeout cannot be faked faster.
  }, 20_000);

  it("seals failure.md naming the step and the cause", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    // Two 500s: the initial attempt and the retry both fail at transport level,
    // which is not a parse failure and so is not swallowed into a default.
    const server = await mockOllama([
      { kind: "status", status: 500, body: "model server exploded" },
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    let failed: unknown;
    let sessionDir = "";
    try {
      await runSession({
        config,
        paths,
        trigger: messageTrigger(testMessage()),
        identity: testIdentity(),
        history: testHistory(),
        rng: () => 0,
      });
    } catch (cause) {
      failed = cause;
    }
    expect(failed).toBeDefined();

    // The session directory is the newest one; find it rather than guessing.
    const { readdir } = await import("node:fs/promises");
    const entries = (await readdir(paths.sessions)).sort();
    sessionDir = path.join(paths.sessions, entries.at(-1) as string);

    const failure = await readFile(path.join(sessionDir, "failure.md"), "utf8");
    expect(failure).toContain("# Session failed");
    expect(failure).toContain("react");
    expect(failure).toContain("model server exploded");
    // And it points at what the step had managed to write.
    expect(failure).toContain("react.partial");
  });
});

describe("absorbed arrivals do not start their own session", () => {
  it("reports which messages the session took into account", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, cleanup } = await tempWorkingDir();
    const RACE = JSON.stringify({
      reason: "same task",
      // `adjust` rather than `continue`: only a verdict that changes what the
      // session is doing means the session took the message on.
      verdict: "adjust",
      message: "Node 22 or newer.",
      finished: true,
      needs_fact: false,
      needs_thought: false,
      steps: [],
    });
    // An `adjust` verdict queues the `adjust` step and then the reply again, so
    // the exact call count is not the point here — supply enough of the
    // combined reply that the sequence cannot run short.
    const server = await mockOllama([
      ...Array.from({ length: 8 }, () => reply(RACE)),
      reply(JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] })),
      reply(JSON.stringify({ assessment: "ok", unanswered: [], carry_forward: "" })),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    let seen = 0;
    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      pending: () => (++seen > 1 ? [testMessage({ id: "m2", text: "and why that one?" })] : []),
    });
    warn.mockRestore();

    // 000006/000007 live: this message used to open a session of its own while
    // the first was still running.
    expect(result.consumed).toEqual(["m2"]);
  });

  it("leaves an arrival it merely carried on past unconsumed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, cleanup } = await tempWorkingDir();
    // `continue` says "this step is still the right step" — nothing about
    // having dealt with the message. Consuming on it dropped unrelated
    // arrivals silently, which is what the `separate-matter` eval case caught.
    const RACE = JSON.stringify({
      reason: "separate matter",
      verdict: "continue",
      message: "Node 22 or newer.",
    });
    // An `adjust` verdict queues the `adjust` step and then the reply again, so
    // the exact call count is not the point here — supply enough of the
    // combined reply that the sequence cannot run short.
    const server = await mockOllama([
      ...Array.from({ length: 8 }, () => reply(RACE)),
      reply(JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] })),
      reply(JSON.stringify({ assessment: "ok", unanswered: [], carry_forward: "" })),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    let seen = 0;
    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      pending: () =>
        ++seen > 1 ? [testMessage({ id: "m3", text: "unrelated — is staging up?" })] : [],
    });
    warn.mockRestore();

    expect(result.consumed ?? []).not.toContain("m3");
  });
});
