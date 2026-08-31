import { describe, expect, it } from "vitest";
import { checkBudget, createBudget, remainingMs, stepTimeoutMs, MIN_STEP_MS } from "../src/session/budget.ts";

const limits = { maxWallclockMs: 10_000, maxModelCalls: 5, maxToolCalls: 5 };

describe("session budget", () => {
  it("allows a fresh session", () => {
    expect(checkBudget(createBudget(limits)).exhausted).toBe(false);
  });

  it("stops on wallclock", () => {
    const budget = createBudget(limits, Date.now() - 11_000);
    const state = checkBudget(budget);
    expect(state.exhausted).toBe(true);
    expect(state.reason).toContain("wallclock");
  });

  it("stops on model calls, which wallclock alone never bounded", () => {
    const budget = { ...createBudget(limits), modelCalls: 5 };
    expect(checkBudget(budget)).toMatchObject({ exhausted: true });
    expect(checkBudget(budget).reason).toContain("model calls");
  });

  it("stops on tool calls", () => {
    const budget = { ...createBudget(limits), toolCalls: 6 };
    expect(checkBudget(budget).reason).toContain("tool calls");
  });

  it("reports remaining wallclock, so a selectable step cannot outlive the session", () => {
    const budget = createBudget(limits, Date.now() - 4_000);
    expect(remainingMs(budget)).toBeGreaterThan(5_000);
    expect(remainingMs(budget)).toBeLessThanOrEqual(6_000);
    expect(remainingMs(createBudget(limits, Date.now() - 99_000))).toBe(0);
  });
});

/**
 * `session/run.ts:000112`-shaped bug: `reason` and `draft` (both selectable)
 * legitimately spent an entire 900s session budget without producing
 * anything salvageable, and `respond`/`review` — necessary steps that ran
 * afterward — were clamped to the dregs of that budget and failed on a
 * 5-second deadline nowhere near enough for a real call. Fixed by only
 * clamping steps the session actually chose to spend its wallclock on.
 */
describe("stepTimeoutMs", () => {
  const exhausted = createBudget(limits, Date.now() - 99_000); // remainingMs is 0

  it("never clamps a non-selectable step, however exhausted the budget", () => {
    expect(stepTimeoutMs(exhausted, 600_000, false)).toBe(600_000);
  });

  it("clamps a selectable step to what remains, floored at MIN_STEP_MS", () => {
    expect(stepTimeoutMs(exhausted, 600_000, true)).toBe(MIN_STEP_MS);
  });

  it("still lets a selectable step's own timeout win when the budget has room", () => {
    const fresh = createBudget(limits); // remainingMs is the full 10_000
    expect(stepTimeoutMs(fresh, 7_000, true)).toBe(7_000);
  });

  it("caps a selectable step at what remains even with a generous configured timeout", () => {
    const tight = createBudget(limits, Date.now() - 8_000); // ~2_000ms remains
    const timeout = stepTimeoutMs(tight, 600_000, true);
    expect(timeout).toBeLessThan(600_000);
    expect(timeout).toBeGreaterThanOrEqual(MIN_STEP_MS);
  });
});
