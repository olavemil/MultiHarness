import { afterEach, describe, expect, it } from "vitest";
import { resetTurns, turnQueueDepth, withTurn } from "../src/session/turn.ts";
import { messageTrigger } from "../src/core/trigger.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { mockOllama, reply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
  entryReplies,
} from "./helpers/fixtures.ts";

/**
 * One session at a time, across the whole daemon.
 *
 * The property under test is not throughput but *ordering*: the message that
 * arrived first is answered first, rather than every session inching along
 * together and all of them finishing late. What must survive is the concurrency
 * inside a session — see `session.test.ts`, which asserts that `update` still
 * runs alongside its step.
 */

afterEach(() => resetTurns());

/** Resolves when told to, so ordering is decided by the test and not by timing. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("withTurn", () => {
  it("runs the second session only after the first finishes", async () => {
    const first = gate();
    const order: string[] = [];

    const a = withTurn(async () => {
      order.push("a:start");
      await first.opened;
      order.push("a:end");
    });
    await Promise.resolve();
    const b = withTurn(async () => void order.push("b:start"));

    expect(order).toEqual(["a:start"]);
    expect(turnQueueDepth()).toBe(1);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("serves waiters in the order they arrived", async () => {
    // FIFO is what makes this defensible: without it a busy channel could
    // starve a quiet one, and "whoever asked first is answered first" is the
    // whole justification for holding the turn for a whole session.
    const held = gate();
    const order: string[] = [];
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();

    const rest = ["b", "c", "d"].map((name) =>
      withTurn(async () => void order.push(name)),
    );

    held.open();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["b", "c", "d"]);
  });

  it("does not let a latecomer take the slot ahead of the queue", async () => {
    // The hand-off has to transfer the slot rather than free it. `resolve` only
    // schedules a microtask, so decrementing first leaves a gap in which a
    // session arriving synchronously could barge past everything queued.
    const held = gate();
    const order: string[] = [];
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();

    const queued = withTurn(async () => void order.push("queued"));
    await Promise.resolve();

    held.open();
    const latecomer = withTurn(async () => void order.push("latecomer"));

    await Promise.all([first, queued, latecomer]);
    expect(order).toEqual(["queued", "latecomer"]);
  });

  it("admits as many as the configured size", async () => {
    const held = gate();
    const running: string[] = [];

    const a = withTurn(async () => {
      running.push("a");
      await held.opened;
    }, { size: 2 });
    await Promise.resolve();
    const b = withTurn(async () => {
      running.push("b");
      await held.opened;
    }, { size: 2 });
    await Promise.resolve();

    expect(running).toEqual(["a", "b"]);
    held.open();
    await Promise.all([a, b]);
  });

  it("reports how long a session waited", async () => {
    const held = gate();
    let waited = -1;
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();
    const second = withTurn(async (ms) => void (waited = ms));

    setTimeout(held.open, 30);
    await Promise.all([first, second]);
    expect(waited).toBeGreaterThanOrEqual(20);
  });

  it("reports how many were ahead of it", async () => {
    const held = gate();
    let depth = -1;
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();
    const second = withTurn(async () => void (await held.opened));
    await Promise.resolve();
    const third = withTurn(async (_ms, ahead) => void (depth = ahead));

    held.open();
    await Promise.all([first, second, third]);
    expect(depth).toBe(2);
  });

  it("does not leak a slot on every hand-off", async () => {
    // The release transfers the slot rather than freeing it, so a woken waiter
    // must not claim a second one. Left unchecked, `size` silently stops
    // meaning anything after the first contended session — and the symptom is
    // the thing this whole mechanism exists to prevent, coming back quietly.
    for (let i = 0; i < 3; i++) {
      const held = gate();
      const running = withTurn(async () => void (await held.opened));
      await Promise.resolve();
      const queued = withTurn(async () => {});
      held.open();
      await Promise.all([running, queued]);
    }

    const held = gate();
    let secondRan = false;
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();
    const second = withTurn(async () => void (secondRan = true));
    await Promise.resolve();

    expect(secondRan, "size 1 must still admit only one").toBe(false);
    held.open();
    await Promise.all([first, second]);
  });

  it("releases the turn when the session throws", async () => {
    // A leaked turn does not degrade the daemon, it stops it permanently —
    // which is why this takes a callback rather than acquire/release.
    await expect(
      withTurn(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrowError("boom");

    let ran = false;
    await withTurn(async () => void (ran = true));
    expect(ran).toBe(true);
  });

  it("lets a cancelled session leave the queue", async () => {
    const held = gate();
    const first = withTurn(async () => void (await held.opened));
    await Promise.resolve();

    const controller = new AbortController();
    let waitingRan = false;
    const queued = withTurn(async () => void (waitingRan = true), {
      signal: controller.signal,
    });

    expect(turnQueueDepth()).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrowError("cancelled");
    expect(turnQueueDepth()).toBe(0);

    held.open();
    await first;
    expect(waitingRan).toBe(false);
  });
});

describe("what holding a turn must not break", () => {
  // The turn is per *session*, so everything inside one belongs to the holder
  // and must still run concurrently. `session/run.ts` awaits
  // `Promise.allSettled([stepRun, updateRun])` so the supervisor runs alongside
  // the step it supervises — the one arrangement the design forbids serialising.
  it("still runs the supervisor alongside the step it supervises", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    // Held long enough that an overlap is unmissable. Replies are served in
    // arrival order regardless of path, so the assertion is on the server's own
    // concurrency count rather than on which reply went where.
    // `RACE` satisfies both the `update` and `respond` schemas — Zod strips the
    // keys each does not declare — so which of the concurrent pair reaches the
    // mock first cannot matter. Borrowed from `debrief.test.ts`, which solved
    // exactly this. `delayMs` is what makes the overlap observable at all.
    const RACE = JSON.stringify({
      reason: "still the same task",
      verdict: "continue",
      message: "Node 22 or newer.",
    });
    const server = await mockOllama(
      [
        ...entryReplies(true).map(reply),
        reply(RACE),
        reply(RACE),
        reply(JSON.stringify({ assessment: "Fine.", quality: 4, recommendations: [] })),
        reply(
          JSON.stringify({ assessment: "ok", unanswered: [], carry_forward: "" }),
        ),
      ],
      { delayMs: 80 },
    );

    try {
      const config = await testConfig(server.host, dir);
      const paths = resolvePaths(config.working_dir);
      await ensurePaths(paths);

      let seen = 0;
      await withTurn(async () => {
        await runSession({
          config,
          paths,
          trigger: messageTrigger(testMessage()),
          identity: testIdentity(),
          history: testHistory(),
          rng: () => 0,
          // Arrives after the entry step, which is what triggers the supervisor.
          pending: () =>
            ++seen > 1 ? [testMessage({ id: "m2", authorName: "kari", text: "and staging?" })] : [],
        });
      });

      expect(server.maxConcurrent(), "update must overlap its step").toBeGreaterThan(1);
    } finally {
      await server.close();
      await cleanup();
    }
  });

  it("lets a session complete while a turn is held elsewhere", async () => {
    // Nothing inside `runSession` may take a turn. If anything did, this would
    // deadlock at size 1 rather than fail — so it is worth pinning explicitly.
    const { dir, cleanup } = await tempWorkingDir();
    const server = await mockOllama([
      ...entryReplies(false).map(reply),
      reply(JSON.stringify({ assessment: "ok", quality: 3, recommendations: [] })),
    ]);

    try {
      const config = await testConfig(server.host, dir);
      const paths = resolvePaths(config.working_dir);
      await ensurePaths(paths);

      const held = gate();
      const holder = withTurn(async () => void (await held.opened));
      await Promise.resolve();

      const result = await runSession({
        config,
        paths,
        trigger: messageTrigger(testMessage()),
        identity: testIdentity(),
        history: testHistory(),
        rng: () => 0,
      });
      expect(result.completed.length).toBeGreaterThan(0);

      held.open();
      await holder;
    } finally {
      await server.close();
      await cleanup();
    }
  });
});
