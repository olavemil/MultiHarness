/**
 * One call at a time, per model.
 *
 * Two sessions reaching a `reasoning` step at once do not get two models: ollama
 * holds one copy of the weights and queues the requests behind each other. The
 * requests still *look* concurrent to us, so both deadlines run while only one
 * call makes progress, and both can time out having produced nothing. Waiting on
 * this side instead turns an invisible queue into an explicit one.
 *
 * Two consequences beyond not timing out, and the second is the more valuable:
 *
 * - The deadline starts when the call does, so waiting costs no part of it.
 * - **One finishes before the other starts.** Two agents answering at the same
 *   moment after a long delay can neither see nor react to each other; staggered,
 *   the second is a session whose `update` can see the first's answer and adjust
 *   or stand down. Serialising for throughput happens to buy the coordination
 *   that item 4's deferral is also reaching for.
 *
 * **Keyed by model id, not role name.** `reasoning` and `digest` are the same
 * weights with thinking switched off — a lease per role would let them run
 * concurrently and contend exactly as before.
 *
 * **Process-wide, which is as far as it goes today.** Instances are separate
 * processes, so this serialises the channels within one of them. It becomes the
 * cross-instance guarantee the moment they share a daemon (roadmap 4a), with no
 * change here.
 */

interface Waiter {
  resolve: () => void;
  reject: (cause: unknown) => void;
}

interface Lane {
  busy: boolean;
  waiting: Waiter[];
}

const lanes = new Map<string, Lane>();

const laneFor = (model: string): Lane => {
  let lane = lanes.get(model);
  if (!lane) {
    lane = { busy: false, waiting: [] };
    lanes.set(model, lane);
  }
  return lane;
};

export interface LeaseResult<T> {
  value: T;
  /** How long the call spent queued. Excluded from the session budget. */
  waitedMs: number;
}

/**
 * Runs `work` with exclusive use of `model`, queueing FIFO behind anything
 * already running on it.
 *
 * FIFO rather than a free-for-all so a busy channel cannot starve a quiet one,
 * and so "whoever asked first answers first" holds — which is what makes the
 * staggering predictable rather than arbitrary.
 */
export async function withModelLease<T>(
  model: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<LeaseResult<T>> {
  const lane = laneFor(model);
  const queuedAt = Date.now();

  if (lane.busy) {
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      lane.waiting.push(waiter);

      // A step cancelled while queued leaves the queue rather than holding its
      // place and then running work nobody wants.
      signal?.addEventListener(
        "abort",
        () => {
          const at = lane.waiting.indexOf(waiter);
          if (at !== -1) {
            lane.waiting.splice(at, 1);
            reject(signal.reason ?? new Error("cancelled while waiting for the model"));
          }
        },
        { once: true },
      );
    });
  }

  lane.busy = true;
  const waitedMs = Date.now() - queuedAt;

  try {
    return { value: await work(), waitedMs };
  } finally {
    // Hand straight to the next waiter rather than clearing `busy`, so nothing
    // that arrives in between can jump the queue.
    const next = lane.waiting.shift();
    if (next) next.resolve();
    else lane.busy = false;
  }
}

/** How many calls are queued on a model. For tests and for reporting. */
export const queueDepth = (model: string): number => lanes.get(model)?.waiting.length ?? 0;

/** Test-only: drops every lane so one test cannot leak a lease into the next. */
export function resetLeases(): void {
  lanes.clear();
}
