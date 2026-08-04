import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/load.ts";
import type { Config } from "../../src/config/schema.ts";
import type { ChannelMessage, Identity, InboundMessage } from "../../src/core/types.ts";

/** A scratch working directory, removed by the returned disposer. */
export async function tempWorkingDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "multiharness-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The real `config/default.toml` with the model server and model ids swapped
 * for test doubles — so tests exercise the shipped configuration rather than a
 * hand-built object that can drift away from it.
 */
export async function testConfig(host: string, workingDir: string): Promise<Config> {
  // The shipped config carries PLACEHOLDER model ids and warns about them; the
  // test doubles below replace those, so the warning is noise here.
  const warn = console.warn;
  console.warn = () => {};
  const config = await loadConfig().finally(() => {
    console.warn = warn;
  });

  return {
    ...config,
    working_dir: workingDir,
    // Off for the general session tests: they exercise pipeline mechanics, and
    // an extra queued reply per case would be noise. The reply-target path has
    // its own tests that turn it back on.
    session: { ...config.session, reply_target: false },
    ollama: { ...config.ollama, host, request_timeout_ms: 5_000 },
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([name, role]) => [name, { ...role, model: `test-${name}` }]),
    ),
  };
}

export const testIdentity = (overrides: Partial<Identity> = {}): Identity => ({
  id: "operator",
  displayName: "operator",
  aliases: [],
  summary: "",
  ...overrides,
});

export const testMessage = (overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  id: "msg-1",
  channelId: "cli",
  identityId: "operator",
  authorName: "operator",
  text: "what version of node is this project on?",
  receivedAt: "2026-08-03T21:00:00.000Z",
  ...overrides,
});

export const testHistory = (): ChannelMessage[] => [
  {
    id: "h1",
    identityId: "operator",
    author: "operator",
    text: "morning",
    at: "2026-08-03T20:59:00.000Z",
    fromAgent: false,
  },
];
