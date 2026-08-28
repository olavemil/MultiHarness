/**
 * What a session's *optional* work is allowed to spend — `selectable_steps`,
 * the ones `schedule`/`adjust`/`plan` chose to spend it on.
 *
 * Necessary pipeline steps (`reflect`, `read`, `stance`, `restate`,
 * `schedule`, `summarize`, `review`, `debrief`, `impression`) and `respond`
 * are not gated by this at all — see `executeModelStep` in `session/run.ts`,
 * which only clamps a step to `remainingMs` when it is in
 * `config.session.selectable_steps`. Each still runs under its own configured
 * `timeout_ms`, so a runaway loop is still bounded; it is just no longer
 * additionally shrunk by however much of the session's wallclock a prior
 * `reason` or `research` call happened to burn. `respond` in particular can
 * legitimately run long and is the one thing worth being late for, which is
 * why it wants a real ceiling of its own rather than the dregs of somebody
 * else's budget — see `[steps.respond] timeout_ms` in `config/default.toml`.
 *
 * Wallclock alone was never a bound on the optional steps either: it was only
 * checked between steps, so one `research` call with a 600s timeout could
 * overrun a 900s session budget on its own. Counting calls bounds the thing
 * `plan` actually controls — it can choose research, reason, and draft in one
 * session.
 *
 * Exhaustion is not a failure. The optional queue truncates to the closing
 * steps, plus `respond` if a reply was promised and has not been written yet:
 * the person waiting gets an answer built from whatever was gathered, at its
 * own full timeout rather than a rushed one.
 */

export interface BudgetLimits {
  maxWallclockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
}

export interface Budget extends BudgetLimits {
  startedAt: number;
  modelCalls: number;
  toolCalls: number;
  /**
   * Time excluded from wallclock because it is not model-runtime work:
   * queueing behind another session's call on the same model, and time spent
   * executing tools between model turns.
   *
   * Excluded from wallclock so selectable-step clamps are based on model work,
   * not resource waits or external I/O latency.
   */
  waitedMs: number;
}

export const createBudget = (limits: BudgetLimits, startedAt = Date.now()): Budget => ({
  ...limits,
  startedAt,
  modelCalls: 0,
  toolCalls: 0,
  waitedMs: 0,
});

export interface BudgetState {
  exhausted: boolean;
  /** Phrased for a log line and for the session summary. */
  reason?: string;
}

/** Wallclock spent on model-runtime work, with excluded time taken out. */
export const workingMs = (budget: Budget, now = Date.now()): number =>
  Math.max(0, now - budget.startedAt - budget.waitedMs);

/**
 * The least wallclock a *selectable* step can be given and still have a
 * chance. Below this the optional part of the session is exhausted, not
 * merely tight, and `checkBudget` says so rather than starting one more
 * `research`/`reason`/`draft`/`plan` call clamped to the dregs of the budget,
 * which cannot finish and fails on its own deadline.
 *
 * Does not apply to `respond` or the necessary pipeline steps — those are
 * never clamped by remaining wallclock at all (see the module comment), so
 * they cannot be floored into a doomed call this way. That used to be a real
 * failure, seen live as `respond` "timed out after 1000ms" when the whole
 * session budget was already spent by the time it ran; fixed at the root by
 * no longer subjecting it to this clamp, rather than by granting it emergency
 * wallclock after the fact.
 */
export const MIN_STEP_MS = 5_000;

export function checkBudget(budget: Budget, now = Date.now()): BudgetState {
  const elapsed = workingMs(budget, now);
  if (budget.maxWallclockMs - elapsed < MIN_STEP_MS) {
    return { exhausted: true, reason: `wallclock ${Math.round(elapsed / 1000)}s of ${Math.round(budget.maxWallclockMs / 1000)}s used` };
  }
  if (budget.modelCalls >= budget.maxModelCalls) {
    return { exhausted: true, reason: `${budget.modelCalls} model calls reached the limit` };
  }
  if (budget.toolCalls >= budget.maxToolCalls) {
    return { exhausted: true, reason: `${budget.toolCalls} tool calls reached the limit` };
  }
  return { exhausted: false };
}

/** Remaining wallclock, so a selectable step's own timeout never outlives the session. */
export const remainingMs = (budget: Budget, now = Date.now()): number =>
  Math.max(0, budget.maxWallclockMs - workingMs(budget, now));

/**
 * The timeout a step actually runs with.
 *
 * Only a *selectable* step — one `schedule`/`adjust`/`plan` chose to spend the
 * session's wallclock on — is clamped to what remains of it, floored at
 * `MIN_STEP_MS` so it is never started with less than a genuine chance. Every
 * other step (the necessary pipeline steps, and `respond`) runs at its own
 * full configured timeout, entirely independent of how much of the session's
 * wallclock earlier steps already spent — see the module comment.
 */
export function stepTimeoutMs(
  budget: Budget,
  configuredTimeoutMs: number,
  selectable: boolean,
  now = Date.now(),
): number {
  if (!selectable) return configuredTimeoutMs;
  return Math.max(MIN_STEP_MS, Math.min(configuredTimeoutMs, remainingMs(budget, now)));
}

/**
 * How much is left, phrased for a prompt.
 *
 * A step that can append other steps needs to know what it can afford —
 * "research, reason, and draft" is a different answer with ten minutes left
 * than with thirty seconds. This is what supersedes `repeat[steps, count]`: a
 * count bounds nothing, whereas a decision-maker told what remains can choose.
 */
export function describeBudget(budget: Budget, now = Date.now()): string {
  const seconds = Math.round(remainingMs(budget, now) / 1000);
  const models = Math.max(0, budget.maxModelCalls - budget.modelCalls);
  const tools = Math.max(0, budget.maxToolCalls - budget.toolCalls);

  if (seconds <= 0 || models <= 0) {
    return "None left — answer directly with what is already available.";
  }
  return (
    `About ${seconds}s of wallclock, ${models} model call${models === 1 ? "" : "s"}, ` +
    `and ${tools} tool call${tools === 1 ? "" : "s"} remain in this session.`
  );
}
