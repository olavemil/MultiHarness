import { createInterface, type Interface } from "node:readline";

/**
 * One reader on stdin, shared by every CLI adapter in the process.
 *
 * Two `readline` interfaces over the same stdin both receive every line and both
 * print their own prompt, which is unusable. Owning the terminal in one place
 * instead makes the console a *room*: a line typed there is delivered to every
 * instance listening, and each decides on its own whether it was for them.
 *
 * That is the same arrangement as a Slack channel with two bots in it, and it is
 * what makes participation damping and standing down testable without a
 * workspace.
 */
export interface ConsoleIo {
  /** Registers a listener and returns an unsubscribe function. Reads nothing yet. */
  subscribe(onLine: (line: string) => void): () => void;
  /**
   * Starts reading, once every instance that wants the console has attached.
   *
   * Subscribing does not read, and that separation is load-bearing. Opening the
   * reader on the first subscriber meant a piped message could be delivered
   * before the second instance had finished starting — it simply never saw the
   * line, and the log was indistinguishable from it having declined to answer.
   * Interactive typing hid this completely.
   *
   * Idempotent, so the caller need not track whether it has run.
   */
  ready(): void;
  write(text: string): void;
  /** Draws the input prompt, at most once per run of output. */
  prompt(): void;
  closed(): Promise<void>;
  close(): void;
}

export function createConsole(): ConsoleIo {
  const listeners = new Set<(line: string) => void>();
  let rl: Interface | undefined;
  let isClosed = false;
  let prompted = false;

  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  function open(): void {
    if (rl || isClosed) return;
    rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

    rl.on("line", (line) => {
      prompted = false;
      const text = line.trim();
      if (text === "") {
        io.prompt();
        return;
      }
      for (const listener of [...listeners]) listener(text);
    });

    rl.on("close", () => {
      isClosed = true;
      markClosed();
    });
  }

  const io: ConsoleIo = {
    subscribe(onLine) {
      listeners.add(onLine);
      return () => {
        listeners.delete(onLine);
        // The console outlives any one instance leaving it. It closes when the
        // last one does, so shutting down a single agent does not take the
        // operator's terminal away from the others.
        if (listeners.size === 0) io.close();
      };
    },

    ready() {
      open();
      io.prompt();
    },

    // Stays valid after close: a session still running when input ended must be
    // able to deliver its reply.
    write(text) {
      prompted = false;
      process.stdout.write(text);
    },

    prompt() {
      if (isClosed || prompted || !rl) return;
      prompted = true;
      rl.prompt();
    },

    closed: () => closed,

    close() {
      if (isClosed) return;
      // A console nobody ever read from still has to report itself closed, or
      // the daemon waits forever on an instance that never opened the terminal.
      if (rl) rl.close();
      else {
        isClosed = true;
        markClosed();
      }
    },
  };

  return io;
}

let shared: ConsoleIo | undefined;

/** The process's one console. Created on first use, so the Slack-only path never opens stdin. */
export function sharedConsole(): ConsoleIo {
  shared ??= createConsole();
  return shared;
}

/**
 * Whether any instance attached to the console.
 *
 * Lets the daemon call `ready()` on it without conjuring one for an all-Slack
 * run — which would open stdin, and a headless daemon has no business holding
 * a terminal it never uses.
 */
export const consoleAttached = (): boolean => shared !== undefined;

/** Test-only: drops the shared console so one test cannot leak a reader into the next. */
export function resetConsole(): void {
  shared = undefined;
}
