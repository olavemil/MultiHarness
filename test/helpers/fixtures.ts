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
  // No instance layer: tests describe their own world, and must not inherit
  // the agent configured on the machine running them.
  const config = await loadConfig(undefined, path.join(tmpdir(), "multiharness-no-instance")).finally(
    () => {
      console.warn = warn;
    },
  );

  return {
    ...config,
    working_dir: workingDir,
    // Off for the general session tests: they exercise pipeline mechanics, and
    // an extra queued reply per case would be noise. Each has dedicated tests
    // that turn it back on. Empty `selectable_steps` also means `schedule` is
    // skipped, since there would be nothing for it to choose.
    //
    // `participation` is off for a different reason: it is a *draw*, and a
    // suite whose outcomes depend on an RNG measures the RNG. Tests that pass
    // `rng: () => 0` would in fact always speak, but relying on that would make
    // every session test quietly dependent on the participation formula.
    session: {
      ...config.session,
      selectable_steps: [],
      restate_step: "",
      participation: { ...config.session.participation, enabled: false },
      // `standing` is off for a third reason again: it calls the embed model,
      // and `mockOllama` serves the replies a test queues rather than an
      // embedding endpoint. Left on, every situational step would wait out the
      // ollama request timeout. `standing.test.ts` turns it back on against a
      // server that does answer `/api/embed`.
      standing: { ...config.session.standing, enabled: false },
    },
    // Several steps ship with tool allowlists, and each tool loop costs an extra
    // model round trip. Stripped here so mechanics tests count the calls they
    // are actually about; `session.test.ts` covers the shipped tool path
    // directly, which is what stops the allowlists going untested everywhere.
    steps: Object.fromEntries(
      Object.entries(config.steps).map(([name, step]) => [name, { ...step, tools: [] }]),
    ),
    ollama: { ...config.ollama, host, request_timeout_ms: 5_000 },
    roles: Object.fromEntries(
      Object.entries(config.roles).map(([name, role]) => [
        name,
        // Forced to "ollama" regardless of what the shipped config says: the
        // test double this function points every role at is `mockOllama`, an
        // ollama-protocol server, not an omlx one. Whichever backend
        // `config/default.toml` defaults to is a live experiment (roadmap
        // item, currently "omlx"); this fixture describes its own world and
        // must not inherit that.
        { ...role, backend: "ollama" as const, model: `test-${name}` },
      ]),
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

/**
 * The two entry-step replies, in the order the harness asks for them.
 *
 * `react` used to answer "what does this want?" and "have I anything to add?"
 * in one call; they are now `read` (objective) and `stance` (subjective), so
 * every test driving a session that was not addressed by name queues two
 * replies where it used to queue one. Spread it: `...entryReplies(true)`.
 *
 * A message that names the agent skips both — `read` is never queued and
 * `stance` is sealed without a call — so those tests queue neither.
 */
export const entryReplies = (respond: boolean): string[] => [
  JSON.stringify({
    reason: respond ? "asked the agent directly" : "aimed at somebody else",
    target: "nothing",
    addressee: respond ? "agent" : "other",
    wants: respond ? "answer" : "nothing",
  }),
  JSON.stringify({
    reason: respond ? "I know this one" : "not mine to answer",
    interest: respond ? 0.9 : 0,
    reaction: "+1",
  }),
];

/**
 * The prompt a given step was actually sent, found by a phrase only that step's
 * frame contains.
 *
 * Tests used to index `server.requests` by position, which breaks whenever the
 * number of model calls in a session changes — splitting the entry step in two
 * shifted every one of them at once. What a test means is "the prompt `respond`
 * saw", so that is what it should ask for.
 */
const STEP_MARKERS: Record<string, string> = {
  read: "You are analysing a conversation from outside it",
  stance: "have you got something worth saying here?",
  restate: "Restate that message as a single self-contained request",
  schedule: "Decide what preparatory work",
  respond: "You are writing a reply to",
  draft: "You are writing a first pass at a reply",
  reason: "this is where you work out what it means",
  research: "you have tools to check it with",
  plan: "You are writing the plan this channel works to",
  reflect: "You are reviewing somebody else's finished work",
  review: "Judge what happened, for the benefit of later sessions",
  debrief: "Judge how it dealt with what came in",
  impression: "You are reading a record of observations",
};

export function promptFor(
  server: { requests: { body: { messages?: { content?: string }[] } }[] },
  step: keyof typeof STEP_MARKERS | (string & {}),
): string {
  const marker = STEP_MARKERS[step];
  if (!marker) throw new Error(`No prompt marker known for step "${step}".`);
  const found = server.requests.find((r) => (r.body.messages?.[0]?.content ?? "").includes(marker));
  if (!found) {
    throw new Error(
      `No request carried "${step}"'s prompt. ${server.requests.length} request(s) were made.`,
    );
  }
  return found.body.messages?.[0]?.content ?? "";
}
