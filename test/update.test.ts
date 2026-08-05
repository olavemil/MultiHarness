import { describe, expect, it, vi } from "vitest";
import { runUpdate } from "../src/session/update.ts";
import { mockOllama, reply } from "./helpers/mockOllama.ts";
import { testConfig, testMessage } from "./helpers/fixtures.ts";

const verdict = (v: string, reason = "…") => JSON.stringify({ reason, verdict: v });

async function update(replies: string[], pending = [testMessage({ text: "actually never mind" })]) {
  const server = await mockOllama(replies.map(reply));
  try {
    const config = await testConfig(server.host, "/tmp/unused");
    const result = await runUpdate({
      config,
      stepName: "research",
      topic: "find the node version",
      pending,
    });
    return { result, server };
  } finally {
    await server.close();
  }
}

describe("runUpdate", () => {
  it("returns the verdict and its reason", async () => {
    const { result } = await update([verdict("abort", "the question was withdrawn")]);
    expect(result.verdict).toBe("abort");
    expect(result.reason).toBe("the question was withdrawn");
  });

  it("sees the step headline and the new messages, never partial output", async () => {
    const { server } = await update([verdict("continue")]);
    const prompt = server.requests[0]?.body.messages?.[0]?.content ?? "";

    expect(prompt).toContain("research");
    expect(prompt).toContain("find the node version");
    expect(prompt).toContain("actually never mind");
    // There is no partial output to show, and speculating about it is worse
    // than saying nothing.
    expect(prompt).toContain("does not exist");
  });

  it("constrains the verdict to the five the harness can apply", async () => {
    const { server } = await update([verdict("continue")]);
    const format = server.requests[0]?.body.format as {
      properties: { verdict: { enum: string[] } };
    };
    expect(format.properties.verdict.enum).toEqual([
      "continue",
      "adjust",
      "abort",
      "respond_now",
      "defer_to_session",
    ]);
  });

  it("continues when it cannot be parsed — work underway has been paid for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = await update(["not json", "still not json"]);
    warn.mockRestore();

    expect(result.verdict).toBe("continue");
    expect(result.trace.fellBack).toBe(true);
  });
});
