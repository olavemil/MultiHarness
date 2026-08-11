/**
 * What a session is allowed to spend.
 *
 * Wallclock alone was never a bound: it was only checked between steps, so one
 * `research` call with a 600s timeout could overrun a 900s session budget on
 * its own. Counting calls bounds the thing `plan` actually controls — it can
 * now choose research, reason, and draft in one session.
 *
 * Exhaustion is not a failure. The queue truncates to the closing steps, plus
 * `respond` if a reply was promised and has not been written yet: the person
 * waiting gets an answer built from whatever was gathered.
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
   * Time spent queued behind another session's call on the same model.
   *
   * Excluded from wallclock, because waiting for a resource is not work. A
   * session that sat three minutes behind somebody else's `research` has not
   * spent three minutes of its own allowance, and charging it would let a busy
   * machine silently shrink every session on it.
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

/** Wallclock the session actually spent working, with queueing taken out. */
export const workingMs = (budget: Budget, now = Date.now()): number =>
  Math.max(0, now - budget.startedAt - budget.waitedMs);

/**
 * The least wallclock a step can be given and still have a chance.
 *
 * Below this the session is exhausted, not merely tight. A step clamped to the
 * dregs of the budget cannot finish and fails on its deadline — seen live as
 * `respond` "timed out after 1000ms", which was the old floor manufacturing a
 * call that could never have succeeded. Truncating to the closing steps is both
 * cheaper and honest.
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

/** Remaining wallclock, so a step's own timeout never outlives the session. */
export const remainingMs = (budget: Budget, now = Date.now()): number =>
  Math.max(0, budget.maxWallclockMs - workingMs(budget, now));

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
