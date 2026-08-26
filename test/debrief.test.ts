import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import type { InboundMessage } from "../src/core/types.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { loadPriorSession } from "../src/store/priorSession.ts";
import { mockOllama, reply, type MockOllama, type MockReply } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
  entryReplies,
  promptFor,
} from "./helpers/fixtures.ts";

/**
 * `debrief` closes a session that was interrupted. It is the only thing that
 * ever looks back at a supervisor verdict, and the only thing that can notice a
 * question which arrived mid-session and was never answered.
 */


/**
 * The supervisor's `update` runs *concurrently* with the step it watches, so
 * which of the two reaches the mock first is not fixed. This reply satisfies
 * both schemas — Zod strips the keys each one does not declare — which makes the
 * pair order-independent instead of making the test depend on a race.
 */
const RACE = JSON.stringify({
  reason: "still the same task",
  // `update` reads `verdict` as its own enum and `react` reads it as *its* enum,
  // so the two cannot share one field. This object is only ever served to
  // `update`, `respond`, and `review`; `react` gets REACTION above.
  verdict: "continue",
  message: "Node 22 or newer.",
});
const REVIEW = JSON.stringify({ assessment: "Fine.", quality: 4, recommendations: [] });
const DEBRIEF = JSON.stringify({
  assessment: "A question arrived during the reply and was not addressed.",
  unanswered: ["Why that version rather than 20?"],
  carry_forward: "Kari is still owed an answer about why 22 rather than 20.",
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function run(
  replies: MockReply[],
  opts: { pending?: () => InboundMessage[]; tweak?: (c: Config) => Config } = {},
) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { dir, cleanup } = await tempWorkingDir();
  const server: MockOllama = await mockOllama(replies);
  cleanups.push(cleanup, server.close);

  const base = await testConfig(server.host, dir);
  const config = (opts.tweak ?? ((c: Config) => c))(base);
  const paths = resolvePaths(config.working_dir);
  await ensurePaths(paths);

  const result = await runSession({
    config,
    paths,
    trigger: messageTrigger(testMessage()),
    identity: testIdentity(),
    history: testHistory(),
    rng: () => 0,
    pending: opts.pending,
  });
  warn.mockRestore();

  return { result, server, paths, config };
}

/** Arrives once the session is already past its entry step. */
const arrivesLater = (text: string) => {
  let seen = 0;
  return () => (++seen > 1 ? [testMessage({ id: "m2", authorName: "kari", text })] : []);
};

const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");

describe("debrief", () => {
  it("does not run when nothing interrupted the session", async () => {
    // Most sessions. A debrief here would be a digest call spent confirming
    // that nothing happened.
    const { result } = await run([...entryReplies(true).map(reply), reply(RACE), reply(REVIEW)]);

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "respond",
      "summarize",
      "review",
    ]);
    await expect(read(result.session.dir, "debrief.md")).rejects.toThrowError();
  });

  it("runs after the closing steps when something arrived", async () => {
    const { result } = await run(
      [
        ...entryReplies(true).map(reply),
        reply(RACE),
        reply(RACE),
        reply(REVIEW),
        reply(DEBRIEF),
      ],
      { pending: arrivesLater("wait, why that version?") },
    );

    expect(result.completed.map((s) => s.name)).toEqual([
      "read",
      "stance",
      "respond",
      "summarize",
      "review",
      "debrief",
    ]);
    expect(await read(result.session.dir, "debrief.md")).toContain("Why that version rather than");
  });

  it("records an arrival it carried past, and says it stays queued", async () => {
    // The verdict is spelled out rather than named, because the name does not
    // say the thing that matters: whether *this* session took the message on.
    // Reporting a still-queued message as unanswered raised a stale alarm live.
    const { server } = await run(
      [
        ...entryReplies(true).map(reply),
        reply(RACE),
        reply(RACE),
        reply(REVIEW),
        reply(DEBRIEF),
      ],
      { pending: arrivesLater("separately — is staging up?") },
    );

    const debriefPrompt = promptFor(server, "debrief");
    expect(debriefPrompt).toContain("separately — is staging up?");
    expect(debriefPrompt).toContain("gets a session of its own");
  });

  it("is disabled by an empty step name", async () => {
    const { result } = await run(
      [
        ...entryReplies(true).map(reply),
        reply(RACE),
        reply(RACE),
        reply(REVIEW),
      ],
      {
        pending: arrivesLater("anything else?"),
        tweak: (c) => ({ ...c, session: { ...c.session, debrief_step: "" } }),
      },
    );

    expect(result.completed.map((s) => s.name)).not.toContain("debrief");
  });

  it("reaches the next session, where nothing else remembers the question", async () => {
    const { result, paths } = await run(
      [
        ...entryReplies(true).map(reply),
        reply(RACE),
        reply(RACE),
        reply(REVIEW),
        reply(DEBRIEF),
      ],
      { pending: arrivesLater("why 22 rather than 20?") },
    );

    const prior = await loadPriorSession(paths, "cli");
    expect(prior?.id).toBe(result.session.id);
    expect(prior?.debrief).toContain("still owed an answer");
  });
});
