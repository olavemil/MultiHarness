import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { acknowledgementSuggestions, stance } from "../src/steps/stance.ts";
import { normaliseEmoji } from "../src/core/emoji.ts";
import { maintenanceTrigger, messageTrigger } from "../src/core/trigger.ts";
import type { Config } from "../src/config/schema.ts";
import { runSession } from "../src/session/run.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import {
  appendReaction,
  readNewReactions,
  readReactions,
  writeReactionWatermark,
} from "../src/store/reactionStore.ts";
import { pendingMaintenance } from "../src/session/maintenance.ts";
import { mockOllama, reply, type MockOllama } from "./helpers/mockOllama.ts";
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
      ...entryReplies(false).map(reply),
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

  it("says nothing at all when nobody has reacted", async () => {
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
      ...entryReplies(false).map(reply),
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
    // Absent, not announced. A heading over "nobody has reacted" is one more
    // thing for the step to weigh, and it weighs it — the whole reason `reflect`
    // had to be told not to read the room for remarks about its own silence.
    expect(reflectPrompt).not.toContain("Reactions people put on");
    expect(reflectPrompt).not.toContain("nobody has reacted");
  });
});

describe("the acknowledgement vocabulary", () => {
  const withVocab = async (acknowledgements: Record<string, string>, emoji = "+1") => {
    const base = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    return { ...base, session: { ...base.session, acknowledgements, acknowledge_emoji: emoji } };
  };

  it("does not constrain the emoji to the configured suggestions", async () => {
    // Compiling the list into the schema meant the agent could only ever pick
    // from something somebody wrote for it — safe, and the reason it never read
    // like a person reacting. Whether an emoji exists is Slack's answer to give.
    const config = await withVocab({ eyes: "seen it", pray: "thanks" });
    const { properties } = z.toJSONSchema(stance.buildSchema(config, {} as never)) as {
      properties: Record<string, { enum?: string[]; type?: string }>;
    };
    expect(properties["reaction"]?.enum).toBeUndefined();
    expect(properties["reaction"]?.type).toBe("string");
  });

  it("decodes the reaction after the interest it must not disturb", async () => {
    // `interest` gates the verdict, the participation draw, and whether the
    // reply may name anybody. A third field decoded ahead of it would be a
    // third thing that could move it.
    const config = await withVocab({ "+1": "fine" });
    const { properties } = z.toJSONSchema(stance.buildSchema(config, {} as never)) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(properties)).toEqual(["reason", "interest", "reaction"]);
  });

  it("suggests the fallback alone when nothing else is configured", async () => {
    const config = await withVocab({}, "ok_hand");
    expect(acknowledgementSuggestions(config)).toContain(":ok_hand:");
  });

  it("falls back to the emoji that is never wrong when it cannot be parsed", async () => {
    const config = await withVocab({ eyes: "seen it" }, "+1");
    expect(stance.fallback(config).reaction).toBe("+1");
  });

  it("renders the suggestions and their meanings into the prompt", async () => {
    // The meanings live in config rather than the prompt because the list is a
    // property of a workspace — custom emoji differ per Slack — so a meaning
    // that did not travel with its emoji would be wrong the moment the list
    // was edited.
    const config = await withVocab({ eyes: "seen it, will look properly" });
    const rendered = stance.variables?.(config, {} as never)["acknowledge_options"] ?? "";
    expect(rendered).toContain(":eyes:");
    expect(rendered).toContain("seen it, will look properly");
  });

});

describe("marking a message before slow work", () => {
  const REVIEW = JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] });

  it("marks it once schedule chooses work, before that work runs", async () => {
    // Scheduling any step is the moment the reply stops being immediate:
    // `research` and `reason` run on the large weights for tens of seconds to
    // minutes, and the person saw nothing at all in that window.
    const marked: { emoji: string; requestsSoFar: number }[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      ...entryReplies(true).map(reply),
      reply(
        JSON.stringify({
          reason: "needs looking up",
          needs_fact: true,
          needs_thought: false,
          steps: [{ step: "research", topic: "find the version" }],
          reaction: "mag",
        }),
      ),
      reply(JSON.stringify({ findings: "Node 22.", gaps: [] })),
      reply(JSON.stringify({ message: "Node 22." })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = {
      ...base,
      session: { ...base.session, selectable_steps: ["research"] },
      steps: { ...base.steps, research: { ...base.steps["research"], tools: [] } },
    };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ id: "msg-5" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onAcknowledge: async (_id, emoji) =>
        void marked.push({ emoji, requestsSoFar: server.requests.length }),
    });

    // The agent's own choice of how to say "gone to look this up".
    expect(marked.map((m) => m.emoji)).toEqual(["mag"]);
    // Before `research` was asked for, not after: read, stance, schedule = 3.
    expect(marked[0]?.requestsSoFar).toBe(3);
  });

  it("does not mark a message it is about to answer directly", async () => {
    // A reply arriving seconds later needs no warning; marking it and then
    // answering would be noise rather than courtesy.
    const marked: string[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      ...entryReplies(true).map(reply),
      reply(
        JSON.stringify({
          reason: "answer directly",
          needs_fact: false,
          needs_thought: false,
          steps: [],
          reaction: "eyes",
        }),
      ),
      reply(JSON.stringify({ message: "Node 22." })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const base = await testConfig(server.host, dir);
    const config = { ...base, session: { ...base.session, selectable_steps: ["research"] } };
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage()),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onAcknowledge: async (_id, emoji) => void marked.push(emoji),
    });

    expect(marked).toEqual([]);
  });
});

describe("acknowledging instead of replying", () => {
  const REVIEW = JSON.stringify({ assessment: "ok", quality: 4, recommendations: [] });

  /**
   * The reading and stance that *derive* to each verdict.
   *
   * The verdict is no longer decoded, so a test cannot hand one to the model —
   * it hands the facts the harness derives it from, which is closer to what a
   * live session sees anyway.
   */
  type Shape = { addressee: string; wants: string; interest: number; reaction: string };
  const READINGS: Record<string, Shape> = {
    // Addressed to the agent, wanting nothing back: thanks, a confirmation.
    // `pray` rather than the fallback, so the test proves the agent's own
    // choice is what gets sent rather than the configured default.
    acknowledge: { addressee: "agent", wants: "acknowledgement", interest: 0.1, reaction: "pray" },
    // Somebody else's exchange, and nothing to add to it.
    for_someone_else: { addressee: "other", wants: "nothing", interest: 0, reaction: "+1" },
    // A remark to the room the agent has nothing to add to.
    tangent: { addressee: "room", wants: "nothing", interest: 0, reaction: "+1" },
  };

  async function reactTo(verdict: string, tweak: (c: Config) => Config = (c) => c) {
    const marked: { messageId: string; emoji: string }[] = [];
    const sent: string[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const shape = READINGS[verdict] as Shape;
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "they said thanks",
          target: "nothing",
          addressee: shape.addressee,
          wants: shape.wants,
        }),
      ),
      reply(JSON.stringify({ reason: "nothing to add", interest: shape.interest, reaction: shape.reaction })),
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

    // The emoji the agent chose, not the configured fallback: thanks gets
    // thanks back rather than a thumbs-up, which is the point of a vocabulary.
    expect(marked).toEqual([{ messageId: "msg-7", emoji: "pray" }]);
    expect(sent).toEqual([]);
    expect(result.reply).toBeUndefined();
    expect(result.decision?.verdict).toBe("acknowledge");
    expect(result.completed.map((s) => s.name)).toEqual(["read", "stance", "summarize", "review"]);
  });

  it("uses a single fuzzy match when the chosen reaction has a typo", async () => {
    const marked: { messageId: string; emoji: string }[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "thanks",
          target: "nothing",
          addressee: "agent",
          wants: "acknowledgement",
        }),
      ),
      reply(JSON.stringify({ reason: "just acknowledging", interest: 0.1, reaction: "thmbsup" })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ id: "msg-fuzzy" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      resolveReaction: async (emoji) =>
        emoji === "thmbsup"
          ? { kind: "fuzzy", emoji: "thumbsup", score: 0.91 }
          : { kind: "exact", emoji },
      onAcknowledge: async (messageId, emoji) => void marked.push({ messageId, emoji }),
    });

    expect(marked).toEqual([{ messageId: "msg-fuzzy", emoji: "thumbsup" }]);
    // No rerun needed when there is one clear candidate.
    expect(server.requests.length).toBe(3);
  });

  it("reruns stance with candidate context when several names match", async () => {
    const marked: { messageId: string; emoji: string }[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "thanks",
          target: "nothing",
          addressee: "agent",
          wants: "acknowledgement",
        }),
      ),
      reply(JSON.stringify({ reason: "just acknowledging", interest: 0.1, reaction: "thumb" })),
      reply(JSON.stringify({ reason: "pick the first valid one", interest: 0.1, reaction: "thumbsup" })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ id: "msg-ambiguous" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      resolveReaction: async (emoji) => {
        if (emoji === "thumb") {
          return { kind: "ambiguous", candidates: ["thumbsup", "thumbs_up"] };
        }
        if (emoji === "thumbsup") return { kind: "exact", emoji };
        return { kind: "none", emoji };
      },
      onAcknowledge: async (messageId, emoji) => void marked.push({ messageId, emoji }),
    });

    expect(marked).toEqual([{ messageId: "msg-ambiguous", emoji: "thumbsup" }]);
    // read, stance, stance-rerun, review
    expect(server.requests.length).toBe(4);
    const retryPrompt = server.requests[2]?.body.messages?.[0]?.content ?? "";
    expect(retryPrompt).toContain("Reaction validation");
    expect(retryPrompt).toContain(":thumbsup:");
    expect(retryPrompt).toContain(":thumbs_up:");
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

  it("marks rather than answers a bare acknowledgement that named the agent", async () => {
    // The mention loop, seen live: two instances named each other in messages
    // that asked nothing. Being named forces the probability to 1.0 and takes
    // no draw, so every damping term was disabled by the very thing causing the
    // loop, and each compelled answer named the other agent again.
    //
    // Both entry steps run on the named path now. `read` sees an
    // acknowledgement, and the loop ends with an emoji instead of a reply.
    const marked: { messageId: string; emoji: string }[] = [];
    const sent: string[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "names the agent to agree with it; asks nothing",
          target: "nothing",
          addressee: "agent",
          wants: "acknowledgement",
        }),
      ),
      reply(JSON.stringify({ reason: "I would only be agreeing back", interest: 0, reaction: "+1" })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ id: "msg-9", text: "@harness good point, agreed" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onReply: async (text) => void sent.push(text),
      onAcknowledge: async (messageId, emoji) => void marked.push({ messageId, emoji }),
    });

    expect(result.decision?.verdict).toBe("acknowledge");
    expect(marked).toEqual([{ messageId: "msg-9", emoji: "+1" }]);
    // Nothing goes into the channel, so nothing names anybody, so nothing is
    // compelled to answer it back. That is the whole fix.
    expect(sent).toEqual([]);
    expect(result.reply).toBeUndefined();
  });

  it("still answers a question that named the agent, however little it has to add", async () => {
    // The property that had to survive the loop fix. Letting a low interest
    // silence a direct question would reintroduce the exact failure mention
    // detection exists to prevent.
    const sent: string[] = [];
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "asks the agent something directly",
          target: "nothing",
          addressee: "agent",
          wants: "answer",
        }),
      ),
      reply(JSON.stringify({ reason: "not much, but I was asked", interest: 0, reaction: "+1" })),
      reply(JSON.stringify({ message: "Node 22." })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    const result = await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ text: "@harness what node version?" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
      onReply: async (text) => void sent.push(text),
    });

    expect(result.decision?.verdict).toBe("reply");
    expect(sent).toEqual(["Node 22."]);
  });

  it("forbids the reply from naming anybody when it has little to add", async () => {
    // The other end of the loop. A reply that names somebody compels a reply,
    // so an agent with nothing much to say must not hand the exchange on.
    const { dir, cleanup } = await tempWorkingDir();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          reason: "a remark to the room the agent was named in",
          target: "nothing",
          addressee: "room",
          wants: "answer",
        }),
      ),
      reply(JSON.stringify({ reason: "barely worth saying", interest: 0.1, reaction: "+1" })),
      reply(JSON.stringify({ message: "Sounds right." })),
      reply(REVIEW),
    ]);
    cleanups.push(cleanup, server.close);

    const config = await testConfig(server.host, dir);
    const paths = resolvePaths(config.working_dir);
    await ensurePaths(paths);

    await runSession({
      config,
      paths,
      trigger: messageTrigger(testMessage({ text: "@harness that about covers it" })),
      identity: testIdentity(),
      history: testHistory(),
      rng: () => 0,
    });

    expect(promptFor(server, "respond")).toContain("Do not @mention anybody");
  });

  it("stays silent when no emoji is configured", async () => {
    const { marked } = await reactTo("acknowledge", (c) => ({
      ...c,
      session: { ...c.session, acknowledge_emoji: "" },
    }));
    expect(marked).toEqual([]);
  });
});

describe("reflecting on a reaction nobody followed up", () => {
  const paths = async () => {
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const p = resolvePaths(dir);
    await ensurePaths(p);
    return p;
  };

  const mark = (emoji: string, at: string) => ({
    messageId: "reply-1",
    emoji,
    author: "olav",
    at,
    removed: false,
  });

  it("reports a fresh reaction as maintenance work", async () => {
    // The one signal that arrives without anybody speaking. It used to be read
    // only at the start of the next real exchange — which never comes if the
    // reaction *was* the last word.
    const p = await paths();
    const config = await testConfig("http://127.0.0.1:1", p.root);
    await appendReaction(p, "cli", mark("thumbsdown", "2026-08-14T09:00:00.000Z"));

    const work = await pendingMaintenance(p, config, testIdentity(), "cli");
    expect(work?.steps).toContain("reflect");
    expect(work?.reason).toContain("thumbsdown");
  });

  it("stops reporting it once it has been reflected on", async () => {
    // Without a watermark the condition never stops being true, and the channel
    // reflects on the same 👍 on every sweep for ever.
    const p = await paths();
    const config = await testConfig("http://127.0.0.1:1", p.root);
    await appendReaction(p, "cli", mark("thumbsup", "2026-08-14T09:00:00.000Z"));

    await writeReactionWatermark(p, "cli", "2026-08-14T09:00:00.000Z");
    const work = await pendingMaintenance(p, config, testIdentity(), "cli");
    expect(work?.steps ?? []).not.toContain("reflect");
  });

  it("reports one that arrived after the watermark", async () => {
    const p = await paths();
    const config = await testConfig("http://127.0.0.1:1", p.root);
    await appendReaction(p, "cli", mark("thumbsup", "2026-08-14T09:00:00.000Z"));
    await appendReaction(p, "cli", mark("confused", "2026-08-14T10:00:00.000Z"));
    await writeReactionWatermark(p, "cli", "2026-08-14T09:30:00.000Z");

    const fresh = await readNewReactions(p, "cli");
    expect(fresh.map((r) => r.emoji)).toEqual(["confused"]);
    expect((await pendingMaintenance(p, config, testIdentity(), "cli"))?.steps).toContain("reflect");
  });

  it("does not report a reaction that was taken away again", async () => {
    // Somebody trying an emoji and thinking better of it says nothing about the
    // answer, and is certainly not worth waking a session for.
    const p = await paths();
    const config = await testConfig("http://127.0.0.1:1", p.root);
    await appendReaction(p, "cli", mark("tada", "2026-08-14T09:00:00.000Z"));
    await appendReaction(p, "cli", { ...mark("tada", "2026-08-14T09:01:00.000Z"), removed: true });

    expect(await readNewReactions(p, "cli")).toEqual([]);
    const work = await pendingMaintenance(p, config, testIdentity(), "cli");
    expect(work?.steps ?? []).not.toContain("reflect");
  });

  it("runs reflect with the reaction and no message at all", async () => {
    // `reflect` used to require the incoming message. A reaction with nobody
    // speaking afterwards is exactly the case where the signal would otherwise
    // never be read — and it is the most direct evidence this step ever gets.
    const p = await paths();
    const server: MockOllama = await mockOllama([
      reply(
        JSON.stringify({
          assessment: "They marked the last answer as wrong.",
          signal: "dissatisfied",
          correction: "",
          recommendations: [],
          impression: "corrects with a reaction rather than a message",
        }),
      ),
    ]);
    cleanups.push(server.close);
    const config = await testConfig(server.host, p.root);

    const result = await runSession({
      config,
      paths: p,
      trigger: maintenanceTrigger("cli", "olav reacted :thumbsdown:", ["reflect"]),
      identity: testIdentity(),
      history: testHistory(),
      reactions: [mark("thumbsdown", "2026-08-14T09:00:00.000Z")],
    });

    expect(result.completed.map((s) => s.name)).toContain("reflect");
    const prompt = promptFor(server, "reflect");
    expect(prompt).toContain("thumbsdown");
    // No message, and no heading claiming there was one.
    expect(prompt).not.toContain("The message from");
  });
});
