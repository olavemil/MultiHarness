import { afterEach, describe, expect, it } from "vitest";
import { messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { appendReaction, readReactions } from "../src/store/reactionStore.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";
import {
  tempWorkingDir,
  testConfig,
  testHistory,
  testIdentity,
  testMessage,
} from "./helpers/fixtures.ts";

/**
 * Somebody reacting to the agent's own message.
 *
 * A signal about how an answer landed, not a request — so it is recorded rather
 * than queued, and read by `reflect` at the start of the next real exchange.
 * Running a session for a 👍 would spend a whole pipeline concluding that
 * nothing was asked.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const reaction = (over: Partial<Parameters<typeof appendReaction>[2]> = {}) => ({
  messageId: "cli-1",
  emoji: "thumbsup",
  author: "olav",
  at: new Date().toISOString(),
  removed: false,
  ...over,
});

async function store() {
  const { dir, cleanup } = await tempWorkingDir();
  cleanups.push(cleanup);
  const paths = resolvePaths(dir);
  await ensurePaths(paths);
  return paths;
}

describe("reactionStore", () => {
  it("has nothing to report in a channel nobody has reacted in", async () => {
    expect(await readReactions(await store(), "cli")).toEqual([]);
  });

  it("keeps reactions per channel, oldest first", async () => {
    const paths = await store();
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup" }));
    await appendReaction(paths, "cli", reaction({ emoji: "tada", author: "kari" }));
    await appendReaction(paths, "other", reaction({ emoji: "eyes" }));

    expect((await readReactions(paths, "cli")).map((r) => r.emoji)).toEqual(["thumbsup", "tada"]);
    expect((await readReactions(paths, "other")).map((r) => r.emoji)).toEqual(["eyes"]);
  });

  it("cancels a reaction that was taken away again", async () => {
    // Somebody trying an emoji and thinking better of it says nothing about the
    // answer, so it should not read as a signal.
    const paths = await store();
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup" }));
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup", removed: true }));

    expect(await readReactions(paths, "cli")).toEqual([]);
  });

  it("cancels only the matching one", async () => {
    const paths = await store();
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup", author: "olav" }));
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup", author: "kari" }));
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup", author: "olav", removed: true }));

    expect((await readReactions(paths, "cli")).map((r) => r.author)).toEqual(["kari"]);
  });

  it("survives a truncated final line", async () => {
    // The normal cost of append-only JSONL. One unreadable entry must not hide
    // every reaction written before it.
    const paths = await store();
    await appendReaction(paths, "cli", reaction({ emoji: "thumbsup" }));
    const { appendFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await appendFile(path.join(paths.channels, "cli", "reactions.jsonl"), '{"emo', "utf8");

    expect((await readReactions(paths, "cli")).map((r) => r.emoji)).toEqual(["thumbsup"]);
  });
});

describe("reflect reading reactions", () => {
  it("puts standing reactions in the prompt", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          assessment: "They marked the last answer.",
          signal: "satisfied",
          correction: "",
          recommendations: [],
          impression: "",
        }),
      ),
      reply(JSON.stringify({ reason: "asked me", verdict: "for_someone_else", interest: 0 })),
      reply(JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] })),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      reactions: [
        { messageId: "cli-1", emoji: "thumbsup", author: "olav", at: "", removed: false },
      ],
      // A prior session is what makes `reflect` run at all.
      prior: {
        id: "000001-prior",
        number: 1,
        review: "r",
        summary: "s",
        reflection: "",
        request: "",
        debrief: "",
      },
      rng: () => 0,
    });

    const reflectPrompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(reflectPrompt).toContain(":thumbsup: from olav");
  });

  it("says plainly when nobody has reacted, rather than rendering empty", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          assessment: "Nothing to go on.",
          signal: "no_signal",
          correction: "",
          recommendations: [],
          impression: "",
        }),
      ),
      reply(JSON.stringify({ reason: "not for me", verdict: "for_someone_else", interest: 0 })),
      reply(JSON.stringify({ assessment: "ok", quality: 3, recommendations: [] })),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      prior: {
        id: "000001-prior",
        number: 1,
        review: "r",
        summary: "s",
        reflection: "",
        request: "",
        debrief: "",
      },
      rng: () => 0,
    });

    const reflectPrompt = server.requests[0]?.body.messages?.[0]?.content ?? "";
    expect(reflectPrompt).toContain("nobody has reacted");
  });
});

describe("acknowledging instead of replying", () => {
  const REVIEW = JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] });

  async function reactTo(verdict: string, tweak: (c: Config) => Config = (c) => c) {
    const marked: { messageId: string; emoji: string }[] = [];
    const sent: string[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(JSON.stringify({ reason: "they said thanks", verdict, interest: 0.1 })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = tweak(await testConfig(server.host, dir));
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ id: "msg-7" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onReply: async (text) => void sent.push(text),
      onAcknowledge: async (messageId, emoji) => void marked.push({ messageId, emoji }),
    });
    return { marked, sent, result };
  }

  it("marks the message and writes nothing", async () => {
    // Silence is the worst outcome, especially one-to-one where it reads as the
    // daemon being down. `acknowledge` is how "nothing to add" still answers.
    const { marked, sent, result } = await reactTo("acknowledge");

    expect(marked).toEqual([{ messageId: "msg-7", emoji: "+1" }]);
    expect(sent).toEqual([]);
    expect(result.reply).toBeUndefined();
    expect(result.completed.map((s) => s.name)).toEqual(["react", "summarize", "review"]);
  });

  it("marks nothing for a message aimed at somebody else", async () => {
    // Not the agent's to answer, and not its to mark either.
    const { marked, sent } = await reactTo("for_someone_else");
    expect(marked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("marks nothing on a tangent it has nothing to add to", async () => {
    const { marked } = await reactTo("tangent");
    expect(marked).toEqual([]);
  });

  it("stays silent when no emoji is configured", async () => {
    const { marked } = await reactTo("acknowledge", (c) => ({
      ...c,
      session: { ...c.session, acknowledge_emoji: "" },
    }));
    expect(marked).toEqual([]);
  });
});
