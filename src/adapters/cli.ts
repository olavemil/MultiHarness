import { randomUUID } from "node:crypto";
import { sharedConsole, type ConsoleIo } from "./console.ts";
import type { Adapter } from "./types.ts";

export interface CliAdapterOptions {
  channelId?: string;
  identityId?: string;
  displayName?: string;
  /**
   * Whose reply this is. Omitted for a lone agent, where the prefix would be
   * noise; set to the instance name when several share the console, because
   * otherwise two answers to the same line are indistinguishable.
   */
  label?: string;
  /** The terminal to attach to. Defaults to the process's shared one. */
  io?: ConsoleIo;
}

/**
 * Stdin/stdout binding. Binds nothing to the network.
 *
 * The terminal itself belongs to `console.ts`, not to the adapter: several
 * instances may attach to one console, and a `readline` each would give every
 * line to all of them twice over and print a prompt per agent.
 */
export function createCliAdapter(opts: CliAdapterOptions = {}): Adapter {
  const channelId = opts.channelId ?? "cli";
  const identityId = opts.identityId ?? "operator";
  const displayName = opts.displayName ?? "operator";
  const label = opts.label;

  let io: ConsoleIo | undefined;
  let unsubscribe: (() => void) | undefined;

  const terminal = (): ConsoleIo => (io ??= opts.io ?? sharedConsole());

  return {
    id: "cli",

    async start({ onMessage }) {
      unsubscribe = terminal().subscribe((text) => {
        onMessage({
          id: randomUUID(),
          channelId,
          identityId,
          authorName: displayName,
          text,
          receivedAt: new Date().toISOString(),
        });
      });
    },

    closed: () => terminal().closed(),

    async send(_channelId, text) {
      terminal().write(label ? `\n${label}: ${text}\n\n` : `\n${text}\n\n`);
      terminal().prompt();
    },

    /**
     * There is nothing to attach an emoji *to* on a terminal, so it is printed
     * as what it means: the agent answered, and chose not to use words.
     *
     * Without this the CLI had no `react` at all, so an acknowledgement was
     * indistinguishable from the daemon being down — the exact failure the
     * acknowledgement exists to prevent, still present on one adapter. It went
     * unnoticed while `acknowledge` was rare; a bare mention derives to it now,
     * so it is the common quiet outcome.
     */
    /** One terminal, so a DM is a line like any other — labelled as private. */
    async dm(identityId, text) {
      terminal().write(
        label ? `\n${label} → ${identityId}: ${text}\n\n` : `\n→ ${identityId}: ${text}\n\n`,
      );
      terminal().prompt();
    },

    async react(_channelId, _messageId, emoji) {
      terminal().write(label ? `\n${label}: :${emoji}:\n\n` : `\n:${emoji}:\n\n`);
      terminal().prompt();
    },

    status(_channelId, headline) {
      terminal().write(label ? `   · ${label}: ${headline}\n` : `   · ${headline}\n`);
    },

    // Leaving the console is all this does. The console closes itself once the
    // last instance has left, so one agent shutting down does not take the
    // terminal away from the others.
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
