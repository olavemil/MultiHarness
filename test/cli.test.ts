import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliAdapter } from "../src/adapters/cli.ts";
import { createConsole, resetConsole } from "../src/adapters/console.ts";
import type { InboundMessage } from "../src/core/types.ts";

/**
 * The CLI adapter drives real stdin/stdout, so these tests swap both for
 * in-memory streams. The behaviour under test is lifecycle, not formatting:
 * input ending must not cut off a session that is still running.
 *
 * Each test builds its own console. The shared one is a process singleton, and
 * a test inheriting the previous test's closed terminal passes for entirely the
 * wrong reason — which is what happened when this file first ran against it.
 */
afterEach(() => resetConsole());

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
      const io = createConsole();
      const adapter = createCliAdapter({ io });
      const received: InboundMessage[] = [];
      await adapter.start({ onMessage: (message) => void received.push(message) });
      io.ready();

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
      const io = createConsole();
      const adapter = createCliAdapter({ io });
      await adapter.start({ onMessage: () => {} });
      io.ready();

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
      const io = createConsole();
      const adapter = createCliAdapter({ io });
      await adapter.start({ onMessage: () => {} });
      io.ready();
      stdin.end();
      await adapter.closed();

      // The regression: this used to throw ERR_USE_AFTER_CLOSE, losing the
      // reply of a session that outlived a piped stdin.
      await expect(adapter.send("cli", "Node 22 or newer.")).resolves.toBeUndefined();
      await expect(adapter.stop()).resolves.toBeUndefined();
      expect(written.join("")).toContain("Node 22 or newer.");
    });
  });

  it("says who replied when it is sharing the console", async () => {
    await withStubbedIo(async (_stdin, written) => {
      const io = createConsole();
      const adapter = createCliAdapter({ io, label: "galatea" });
      await adapter.start({ onMessage: () => {} });
      io.ready();

      await adapter.send("cli", "sqlite, on balance.");
      adapter.status?.("cli", "thinking");

      expect(written.join("")).toContain("galatea: sqlite, on balance.");
      expect(written.join("")).toContain("galatea: thinking");
    });
  });
});

describe("a console shared by several instances", () => {
  it("delivers each line to every instance attached", async () => {
    // The console is a room. Two agents in it both see what was typed and each
    // decides on its own whether it was for them — the same arrangement as a
    // Slack channel with two bots in it, and what makes participation damping
    // testable without a workspace.
    await withStubbedIo(async (stdin) => {
      const io = createConsole();
      const heard: string[] = [];

      for (const name of ["galatea", "nephele"]) {
        const adapter = createCliAdapter({ io, label: name });
        await adapter.start({ onMessage: (m) => void heard.push(`${name}:${m.text}`) });
      }

      io.ready();
      stdin.write("who is up?\n");
      stdin.end();
      await io.closed();

      expect(heard).toEqual(["galatea:who is up?", "nephele:who is up?"]);
    });
  });

  it("reads nothing until every instance has attached", async () => {
    // Found live, with two console instances and a piped message: the first to
    // start opened the reader, the line was delivered before the second had
    // finished starting, and the second simply never saw it. The log was
    // indistinguishable from it having declined to answer — and was read that
    // way. Interactive typing hides this completely.
    await withStubbedIo(async (stdin) => {
      const io = createConsole();
      const heard: string[] = [];

      const early = createCliAdapter({ io, label: "early" });
      await early.start({ onMessage: (m) => void heard.push(`early:${m.text}`) });

      // The message is already waiting by the time the slow instance attaches.
      stdin.write("who is up?\n");
      await new Promise((done) => setTimeout(done, 10));

      const late = createCliAdapter({ io, label: "late" });
      await late.start({ onMessage: (m) => void heard.push(`late:${m.text}`) });

      io.ready();
      stdin.end();
      await io.closed();

      expect(heard).toEqual(["early:who is up?", "late:who is up?"]);
    });
  });

  it("gives each instance its own message id for the same line", async () => {
    // They keep separate stores and separate history; a shared id would make
    // two independent sessions look like one message to anything reading both.
    await withStubbedIo(async (stdin) => {
      const io = createConsole();
      const ids: string[] = [];

      for (const name of ["a", "b"]) {
        const adapter = createCliAdapter({ io, label: name });
        await adapter.start({ onMessage: (m) => void ids.push(m.id) });
      }

      io.ready();
      stdin.write("hello\n");
      stdin.end();
      await io.closed();

      expect(new Set(ids).size).toBe(2);
    });
  });

  it("stays open until the last instance has left", async () => {
    // One agent shutting down must not take the operator's terminal away from
    // the others.
    await withStubbedIo(async (_stdin) => {
      const io = createConsole();
      const first = createCliAdapter({ io, label: "a" });
      const second = createCliAdapter({ io, label: "b" });
      await first.start({ onMessage: () => {} });
      await second.start({ onMessage: () => {} });

      io.ready();

      let closed = false;
      void io.closed().then(() => (closed = true));

      await first.stop();
      await Promise.resolve();
      expect(closed).toBe(false);

      await second.stop();
      await io.closed();
      expect(closed).toBe(true);
    });
  });

  it("draws one prompt however many instances are attached", async () => {
    await withStubbedIo(async (_stdin, written) => {
      const io = createConsole();
      for (const name of ["a", "b", "c"]) {
        await createCliAdapter({ io, label: name }).start({ onMessage: () => {} });
      }
      io.ready();
      expect(written.filter((chunk) => chunk === "> ")).toHaveLength(1);
    });
  });
});
