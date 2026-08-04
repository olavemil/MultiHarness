import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCliAdapter } from "../src/adapters/cli.ts";
import type { InboundMessage } from "../src/core/types.ts";

/**
 * The CLI adapter drives real stdin/stdout, so these tests swap both for
 * in-memory streams. The behaviour under test is lifecycle, not formatting:
 * input ending must not cut off a session that is still running.
 */
function withStubbedIo<T>(run: (stdin: PassThrough, written: string[]) => Promise<T>): Promise<T> {
  const stdin = new PassThrough();
  const written: string[] = [];

  const stdinSpy = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as never);
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

  return run(stdin, written).finally(() => {
    stdinSpy.mockRestore();
    writeSpy.mockRestore();
  });
}

describe("cli adapter", () => {
  it("turns each non-empty line into an inbound message", async () => {
    await withStubbedIo(async (stdin) => {
      const adapter = createCliAdapter();
      const received: InboundMessage[] = [];
      await adapter.start((message) => received.push(message));

      stdin.write("hello there\n");
      stdin.write("   \n"); // blank lines are not messages
      stdin.write("second\n");
      stdin.end();
      await adapter.closed();

      expect(received.map((m) => m.text)).toEqual(["hello there", "second"]);
      expect(received[0]?.channelId).toBe("cli");
      expect(received[0]?.authorName).toBe("operator");
      expect(received[0]?.id).not.toBe(received[1]?.id);
    });
  });

  it("resolves closed() when input ends, rather than killing the process", async () => {
    await withStubbedIo(async (stdin) => {
      const adapter = createCliAdapter();
      await adapter.start(() => {});

      let resolved = false;
      const closed = adapter.closed().then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);
      stdin.end();
      await closed;
      expect(resolved).toBe(true);
    });
  });

  it("still delivers a reply that arrives after input has ended", async () => {
    await withStubbedIo(async (stdin, written) => {
      const adapter = createCliAdapter();
      await adapter.start(() => {});
      stdin.end();
      await adapter.closed();

      // The regression: this used to throw ERR_USE_AFTER_CLOSE, losing the
      // reply of a session that outlived a piped stdin.
      await expect(adapter.send("cli", "Node 22 or newer.")).resolves.toBeUndefined();
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(written.join("")).toContain("Node 22 or newer.");
    });
  });
});
