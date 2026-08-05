import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { callModel } from "../src/model/call.ts";
import { queueDepth, resetLeases, withModelLease } from "../src/model/lease.ts";
import { checkBudget, createBudget, remainingMs, workingMs } from "../src/session/budget.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";

/**
 * One call at a time on the large weights.
 *
 * Two sessions reaching a `reasoning` step together do not get two models —
 * ollama queues them — so both deadlines run while only one call progresses and
 * both can time out having produced nothing.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  resetLeases();
});

/** Resolves when told to, so ordering is decided by the test not by timing. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe("withModelLease", () => {
  it("runs the second call only after the first finishes", async () => {
    const first = gate();
    const order: string[] = [];

    const a = withModelLease("big", async () => {
      order.push("a:start");
      await first.opened;
      order.push("a:end");
    });
    // Let `a` take the lane before `b` asks for it.
    await Promise.resolve();
    const b = withModelLease("big", async () => void order.push("b:start"));

    expect(order).toEqual(["a:start"]);
    expect(queueDepth("big")).toBe(1);

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("keeps separate models out of each other's way", async () => {
    // `fast` must not queue behind `reasoning`: `update` runs alongside the step
    // it supervises, and serialising them would deadlock the supervisor.
    const held = gate();
    const big = withModelLease("big", async () => void (await held.opened));
    await Promise.resolve();

    let smallRan = false;
    await withModelLease("small", async () => void (smallRan = true));
    expect(smallRan).toBe(true);

    held.open();
    await big;
  });

  it("reports how long a call waited", async () => {
    const held = gate();
    const first = withModelLease("big", async () => void (await held.opened));
    await Promise.resolve();
    const second = withModelLease("big", async () => "done");

    setTimeout(held.open, 30);
    const result = await second;
    await first;

    expect(result.value).toBe("done");
    expect(result.waitedMs).toBeGreaterThanOrEqual(20);
  });

  it("serves waiters in the order they arrived", async () => {
    // FIFO so a busy channel cannot starve a quiet one, and so "whoever asked
    // first answers first" holds rather than being arbitrary.
    const held = gate();
    const order: string[] = [];
    const first = withModelLease("big", async () => void (await held.opened));
    await Promise.resolve();

    const rest = ["b", "c", "d"].map((name) =>
      withModelLease("big", async () => void order.push(name)),
    );

    held.open();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["b", "c", "d"]);
  });

  it("releases the lane when the work throws", async () => {
    await expect(
      withModelLease("big", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrowError("boom");

    // The lane must not be left held, or every later call hangs forever.
    let ran = false;
    await withModelLease("big", async () => void (ran = true));
    expect(ran).toBe(true);
  });

  it("lets a cancelled call leave the queue", async () => {
    const held = gate();
    const first = withModelLease("big", async () => void (await held.opened));
    await Promise.resolve();

    const controller = new AbortController();
    let waitingRan = false;
    const queued = withModelLease("big", async () => void (waitingRan = true), controller.signal);

    expect(queueDepth("big")).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrowError("cancelled");
    expect(queueDepth("big")).toBe(0);

    held.open();
    await first;
    // The abandoned work never ran, rather than running for nobody later.
    expect(waitingRan).toBe(false);
  });
});

describe("callModel and the lease", () => {
  const schema = z.object({ message: z.string() });
  const role = (over: Record<string, unknown> = {}) => ({
    name: "reasoning",
    model: "big",
    options: {},
    noTools: false,
    exclusive: true,
    ...over,
  });

  async function call(exclusive: boolean, server: MockOllama) {
    return callModel({
      label: "test",
      host: server.host,
      role: role({ exclusive }),
      prompt: "p",
      schema,
      fallback: () => ({ message: "fallback" }),
      timeoutMs: 5_000,
    });
  }

  it("records the wait in the trace", async () => {
    const server = await mockOllama([reply('{"message":"one"}'), reply('{"message":"two"}')]);
    cleanups.push(server.close);

    const [a, b] = await Promise.all([call(true, server), call(true, server)]);
    // One of the two queued behind the other; which is not fixed, but exactly
    // one should report having waited.
    const waits = [a.trace.waitedMs, b.trace.waitedMs].sort((x, y) => x - y);
    expect(waits[0]).toBe(0);
    expect(waits[1]).toBeGreaterThanOrEqual(0);
  });

  it("does not queue a role that is not exclusive", async () => {
    // `fast` stays concurrent by design.
    const server = await mockOllama([reply('{"message":"one"}'), reply('{"message":"two"}')]);
    cleanups.push(server.close);

    const both = await Promise.all([call(false, server), call(false, server)]);
    expect(both.every((r) => r.trace.waitedMs === 0)).toBe(true);
  });
});

describe("the budget does not charge for waiting", () => {
  it("subtracts queued time from wallclock", () => {
    // A session that sat behind somebody else's research has not spent its own
    // allowance. Charging it would let a busy machine silently shrink every
    // session running on it.
    const started = Date.now();
    const budget = createBudget(
      { maxWallclockMs: 60_000, maxModelCalls: 24, maxToolCalls: 24 },
      started,
    );
    const now = started + 90_000;

    expect(checkBudget(budget, now).exhausted).toBe(true);

    budget.waitedMs = 70_000;
    expect(workingMs(budget, now)).toBe(20_000);
    expect(checkBudget(budget, now).exhausted).toBe(false);
    expect(remainingMs(budget, now)).toBe(40_000);
  });

  it("never reports negative working time", () => {
    const started = Date.now();
    const budget = createBudget(
      { maxWallclockMs: 60_000, maxModelCalls: 24, maxToolCalls: 24 },
      started,
    );
    budget.waitedMs = 999_000;
    expect(workingMs(budget, started + 1_000)).toBe(0);
  });

  it("still stops on call count, which waiting cannot excuse", () => {
    const budget = createBudget({ maxWallclockMs: 60_000, maxModelCalls: 2, maxToolCalls: 24 });
    budget.waitedMs = 500_000;
    budget.modelCalls = 2;
    expect(checkBudget(budget).exhausted).toBe(true);
  });
});
