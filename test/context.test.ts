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

/** A step already sealed in this session, for the blocks that read `completed`. */
const sealed = (name: string, content: string) => ({
  name,
  topic: "",
  outputFile: `${name}.md`,
  content,
  durationMs: 1,
});

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
  const build = async (args: Partial<Parameters<typeof buildContext>[0]> = {}) =>
    buildContext({
      input: input(),
      config: await config(),
      voice: "agent",
      headingVars: { sender: "olav" },
      ...args,
    });

  it("resolves inline blocks in the order given", async () => {
    const built = await build({ blocks: ["incoming_message", "user_summary"] });

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
    const built = await buildContext({
      blocks: ["recent_messages"],
      input: input({ history }),
      config: cfg,
      voice: "agent",
    });
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

    const built = await buildContext({
      blocks: ["session_summary"],
      input: input({ completed: [sealed("summarize", "ran two steps")] }),
      config: cfg,
      voice: "agent",
    });
    expect(built.blocks[0]?.budgetTokens).toBe(cfg.context.default_budget_tokens);
  });

  it("names the known blocks when a step declares one that does not exist", async () => {
    await expect(build({ blocks: ["nonsense"] })).rejects.toThrowError(
      /Known blocks: .*incoming_message/,
    );
  });

  // --- The appendix mechanism -----------------------------------------------
  // The whole point of it: a step's prompt is a frame plus whatever context
  // actually exists, never a skeleton of headings over "(nothing here)".

  it("omits an absent appendix block entirely — no heading, no placeholder", async () => {
    const built = await build({ appendix: ["current_plan", "user_summary"] });

    // No plan is running, so it contributes nothing at all.
    expect(built.variables["context"]).not.toContain("plan");
    expect(built.variables["context"]).toContain("Runs the harness.");
    expect(built.blocks.map((b) => b.name)).toEqual(["user_summary"]);
  });

  it("renders nothing at all when every appendix block is absent", async () => {
    const built = await build({
      appendix: ["current_plan", "request", "reactions"],
      input: input({ identity: testIdentity({ summary: "" }) }),
    });
    expect(built.variables["context"]).toBe("");
  });

  it("labels an appendix by the reading step's voice", async () => {
    const withCompleted = input({ completed: [sealed("research", "node 22 ships sqlite")] });

    const own = await build({ appendix: ["prior_step_output"], input: withCompleted });
    const judged = await build({
      appendix: ["prior_step_output"],
      input: withCompleted,
      voice: "observer",
    });

    // The same text, and the only thing separating "this is mine" from "this is
    // material to examine" is the heading over it.
    expect(own.variables["context"]).toContain("## What you worked out earlier in this session");
    expect(judged.variables["context"]).toContain("## Working notes produced during the session");
    expect(own.variables["context"]).toContain("node 22 ships sqlite");
  });

  it("interpolates heading variables so a heading can name the sender", async () => {
    const built = await build({
      appendix: ["user_summary"],
      headingVars: { sender: "dana" },
    });
    expect(built.variables["context"]).toContain("## What you know about dana");
  });

  it("keeps appendix order, so priority order is what reaches the model", async () => {
    const built = await build({
      appendix: ["user_summary", "recent_messages"],
    });
    const ctx = built.variables["context"] ?? "";
    expect(ctx.indexOf("What you know about")).toBeLessThan(ctx.indexOf("The conversation so far"));
  });

  it("keeps appendix blocks out of the inline variables, so nothing renders twice", async () => {
    const built = await build({ appendix: ["user_summary"] });
    expect(built.variables["user_summary"]).toBeUndefined();
  });

  it("fails loudly when a step's frame requires a block the session cannot supply", async () => {
    // A maintenance session has no triggering message. Rendering a frame that
    // says "the message you are answering" over nothing is the failure this
    // guard exists to turn into an error.
    await expect(
      build({ blocks: ["incoming_message"], input: input({ message: undefined }) }),
    ).rejects.toThrowError(/required by this step's prompt/);
  });
});
