import { describe, expect, it } from "vitest";
import { checkBudget, createBudget, remainingMs } from "../src/session/budget.ts";

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

  it("reports remaining wallclock, so a step cannot outlive the session", () => {
    const budget = createBudget(limits, Date.now() - 4_000);
    expect(remainingMs(budget)).toBeGreaterThan(5_000);
    expect(remainingMs(budget)).toBeLessThanOrEqual(6_000);
    expect(remainingMs(createBudget(limits, Date.now() - 99_000))).toBe(0);
  });
});
