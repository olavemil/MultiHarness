/**
 * One session at a time, across the whole daemon.
 *
 * `model/lease.ts` serialises calls on the *same* model id, which leaves the
 * problem that actually bites: two agents, one GPU, **different** models. Nothing
 * connected them, so a 27B step in one instance starved phi4 in the other —
 * `react` measures 1.08s idle and 19–27s alongside a reasoning step, and blew its
 * 30s timeout twice.
 *
 * The turn is held for a **whole session**, which is what makes it FIFO in the
 * sense that matters: the message that arrived first is answered first, rather
 * than every session inching forward together and all of them finishing late.
 *
 * **The concurrency this must not touch** is inside a session: `session/run.ts`
 * awaits `Promise.allSettled([stepRun, updateRun])`, so the `update` supervisor
 * runs *alongside* the step it supervises. Both belong to the holder, so a
 * session-level turn cannot serialise them — provided nothing inside `runSession`
 * ever takes a turn. That invariant is the one to protect when editing this.
 *
 * **Waiting costs no budget, for free.** `runSession` stamps `startedAt` and
 * builds its budget on entry, so acquiring the turn *before* calling it leaves
 * queue time outside the session's wallclock with no accounting anywhere.
 */

interface Waiter {
  resolve: () => void;
  reject: (cause: unknown) => void;
}

/** Module-level, because the point is that it spans every instance in the process. */
let active = 0;
const waiting: Waiter[] = [];

export interface TurnOptions {
  /**
   * How many sessions may run at once. One by default — the whole reason this
   * exists. Raising it brings back cross-model contention in exchange for
   * throughput, and `model/lease.ts` becomes load-bearing again at that point.
   */
  size?: number;
  signal?: AbortSignal;
}

/**
 * Runs `work` as the only session in flight, queueing FIFO behind anything
 * already running.
 *
 * A callback rather than acquire/release so a throw cannot leak the turn: a
 * leaked turn does not degrade the daemon, it stops it permanently.
 *
 * `work` receives how long it waited, for the trace — "why was that reply slow?"
 * is otherwise unanswerable, which is the failure the trace-everything rule
 * exists to prevent.
 */
export async function withTurn<T>(
  work: (waitedMs: number, queueDepth: number) => Promise<T>,
  opts: TurnOptions = {},
): Promise<T> {
  const size = Math.max(1, opts.size ?? 1);
  const queuedAt = Date.now();
  // Everything this session has to wait for: the ones running *and* the ones
  // already queued. `waiting.length` alone undercounts by the holder, which is
  // the one most responsible for the delay being explained.
  const ahead = active >= size ? active + waiting.length : 0;

  if (active < size) {
    active++;
  } else {
    // Queued. The slot is *transferred* by the release below rather than freed,
    // so `active` already accounts for this session by the time it wakes —
    // incrementing again here would leak a slot on every hand-off and `size`
    // would stop meaning anything after the first contended session.
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      waiting.push(waiter);

      // A session cancelled while queued leaves the queue rather than holding
      // its place and then running work nobody is waiting for any more.
      opts.signal?.addEventListener(
        "abort",
        () => {
          const at = waiting.indexOf(waiter);
          if (at !== -1) {
            waiting.splice(at, 1);
            reject(opts.signal?.reason ?? new Error("cancelled while waiting for a turn"));
          }
        },
        { once: true },
      );
    });
  }

  try {
    return await work(Date.now() - queuedAt, ahead);
  } finally {
    // Hand the slot straight to the next waiter instead of freeing it. `resolve`
    // only schedules a microtask, so decrementing first would leave `active`
    // below `size` for long enough that a session arriving synchronously could
    // take the slot ahead of everything already queued — FIFO lost to a barge.
    const next = waiting.shift();
    if (next) next.resolve();
    else active--;
  }
}

/** How many sessions are queued. For the trace and for tests. */
export const turnQueueDepth = (): number => waiting.length;

/** Test-only: drops the queue so one test cannot leak a turn into the next. */
export function resetTurns(): void {
  active = 0;
  waiting.length = 0;
}
