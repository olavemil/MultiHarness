import { describe, expect, it } from "vitest";
import { buildContext } from "../src/context/builder.ts";
import type { BlockInput } from "../src/context/blocks/index.ts";
import { estimateTokens, truncateToTokens } from "../src/context/budget.ts";
import type { ChannelMessage } from "../src/core/types.ts";
import { testConfig, testHistory, testIdentity, testMessage } from "./helpers/fixtures.ts";

const input = (overrides: Partial<BlockInput> = {}): BlockInput => ({
  message: testMessage(),
  history: testHistory(),
  identity: testIdentity({ summary: "Runs the harness." }),
  completed: [],
  ...overrides,
});

const config = async () => testConfig("http://127.0.0.1:1", "/tmp/unused");

describe("truncateToTokens", () => {
  it("leaves text that fits untouched", () => {
    const { text, truncated } = truncateToTokens("short", 100);
    expect(truncated).toBe(false);
    expect(text).toBe("short");
  });

  it("keeps the end when asked, so the newest messages survive", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const { text, truncated } = truncateToTokens(lines, 40, "tail");

    expect(truncated).toBe(true);
    expect(text).toContain("line 199");
    expect(text).not.toContain("line 0\n");
    expect(estimateTokens(text)).toBeLessThanOrEqual(40);
  });

  it("keeps the beginning by default", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const { text } = truncateToTokens(lines, 40, "head");

    expect(text).toContain("line 0");
    expect(text).not.toContain("line 199");
  });

  it("trims rather than empties a single oversized line", () => {
    const { text, truncated } = truncateToTokens("x".repeat(4_000), 20);
    expect(truncated).toBe(true);
    expect(text.length).toBeGreaterThan(0);
    expect(estimateTokens(text)).toBeLessThanOrEqual(25);
  });
});

describe("buildContext", () => {
  it("resolves declared blocks in the order given", async () => {
    const built = await buildContext(
      ["incoming_message", "user_summary"],
      input(),
      await config(),
    );

    expect(built.blocks.map((b) => b.name)).toEqual(["incoming_message", "user_summary"]);
    expect(built.variables["incoming_message"]).toContain("what version of node");
    expect(built.variables["user_summary"]).toContain("Runs the harness.");
  });

  it("applies the per-block budget from config and reports the truncation", async () => {
    const history: ChannelMessage[] = Array.from({ length: 500 }, (_, i) => ({
      id: `h${i}`,
      identityId: "operator",
      author: "operator",
      text: `message number ${i}`,
      at: "2026-08-03T20:00:00.000Z",
      fromAgent: false,
    }));

    const cfg = await config();
    const built = await buildContext(["recent_messages"], input({ history }), cfg);
    const block = built.blocks[0];

    expect(block?.truncated).toBe(true);
    expect(block?.budgetTokens).toBe(cfg.context.budgets["recent_messages"]);
    expect(block?.estimatedTokens).toBeLessThanOrEqual(block?.budgetTokens ?? 0);
    // Truncating history must preserve the most recent exchange.
    expect(built.variables["recent_messages"]).toContain("message number 499");
  });

  it("falls back to the default budget for a block with no explicit entry", async () => {
    const cfg = await config();
    // session_summary is deliberately absent from [context.budgets].
    expect(cfg.context.budgets["session_summary"]).toBeUndefined();

    const built = await buildContext(["session_summary"], input(), cfg);
    expect(built.blocks[0]?.budgetTokens).toBe(cfg.context.default_budget_tokens);
  });

  it("uses the explicit budget when config provides one", async () => {
    const cfg = await config();
    const built = await buildContext(["prior_step_output"], input(), cfg);
    expect(built.blocks[0]?.budgetTokens).toBe(cfg.context.budgets["prior_step_output"]);
  });

  it("names the known blocks when a step declares one that does not exist", async () => {
    await expect(buildContext(["nonsense"], input(), await config())).rejects.toThrowError(
      /Known blocks: .*incoming_message/,
    );
  });

  it("describes an empty channel rather than emitting nothing", async () => {
    const built = await buildContext(["recent_messages"], input({ history: [] }), await config());
    expect(built.variables["recent_messages"]).toContain("no earlier messages");
  });
});
