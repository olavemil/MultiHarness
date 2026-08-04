import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { Adapter } from "./types.ts";

export interface CliAdapterOptions {
  channelId?: string;
  identityId?: string;
  displayName?: string;
}

/** Stdin/stdout binding. Binds nothing to the network. */
export function createCliAdapter(opts: CliAdapterOptions = {}): Adapter {
  const channelId = opts.channelId ?? "cli";
  const identityId = opts.identityId ?? "operator";
  const displayName = opts.displayName ?? "operator";

  let rl: Interface | undefined;
  let isClosed = false;
  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  return {
    id: "cli",

    async start(onMessage) {
      rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
      rl.prompt();

      rl.on("line", (line) => {
        const text = line.trim();
        if (text === "") {
          rl?.prompt();
          return;
        }
        onMessage({
          id: randomUUID(),
          channelId,
          identityId,
          authorName: displayName,
          text,
          receivedAt: new Date().toISOString(),
        });
      });

      rl.on("close", () => {
        isClosed = true;
        markClosed();
      });
    },

    closed: () => closed,

    // A session that was still running when input ended must still be able to
    // deliver its reply, so output stays valid after close — only the prompt
    // goes away.
    async send(_channelId, text) {
      process.stdout.write(`\n${text}\n\n`);
      if (!isClosed) rl?.prompt();
    },

    status(_channelId, headline) {
      process.stdout.write(`   · ${headline}\n`);
    },

    async stop() {
      if (!isClosed) rl?.close();
    },
  };
}
