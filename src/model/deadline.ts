/**
 * A timeout that does not count time the machine was asleep.
 *
 * `AbortSignal.timeout` counts wallclock. Close a laptop lid during a long
 * `reasoning` call and every in-flight step fails on resume — reporting that the
 * *model* exceeded its deadline, which sends an operator to look at ollama where
 * nothing is wrong. This daemon is explicitly meant to run on a laptop, so that
 * is routine rather than exotic.
 *
 * It cost a real measurement before it was understood: a `restate` eval had its
 * last two cases error on all six attempts, and the result was written up as run
 * degradation.
 *
 * **Detection is a late tick, not a system API.** A repeating timer that should
 * fire every second and instead fires minutes later means the process was not
 * running. Node offers no portable "did we suspend" signal, and the late tick is
 * evidence of exactly the thing that matters — time during which no progress
 * could possibly have been made.
 *
 * Sustained heavy load produces the same signature, and is treated the same way
 * on purpose: in both cases the elapsed wallclock is not time the model spent
 * failing to answer, so charging it against the budget is wrong either way.
 */

/** How often to check. Short enough to localise a suspension to its start. */
const TICK_MS = 1_000;

/**
 * A tick this many times late is a suspension rather than scheduler jitter.
 * Ordinary event-loop delay is milliseconds; suspension is seconds to hours.
 */
const LATE_TICK_FACTOR = 5;

export interface Deadline {
  signal: AbortSignal;
  /** Wallclock skipped because the process was not running. */
  suspendedMs(): number;
  /** Stops the timer. Always call it, or the interval outlives the request. */
  release(): void;
}

export function createDeadline(timeoutMs: number, tickMs: number = TICK_MS): Deadline {
  const controller = new AbortController();
  let remaining = timeoutMs;
  let suspended = 0;
  let last = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - last;
    last = now;

    if (elapsed > tickMs * LATE_TICK_FACTOR) {
      // The process was not running for most of that. Charging it to the model
      // is what produced the misleading error in the first place.
      suspended += elapsed;
      return;
    }

    remaining -= elapsed;
    if (remaining <= 0) {
      clearInterval(timer);
      // Named `TimeoutError` because `ollama.ts` distinguishes a timeout from a
      // stream failure by exactly this name.
      controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, "TimeoutError"));
    }
  }, tickMs);

  // Never hold the process open: a pending deadline is not a reason to keep a
  // daemon alive at shutdown.
  timer.unref?.();

  return {
    signal: controller.signal,
    suspendedMs: () => suspended,
    release: () => clearInterval(timer),
  };
}
