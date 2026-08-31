import { afterEach, describe, expect, it } from "vitest";
import { eligibleTargets, channelRef, dmRef } from "../src/core/initiative.ts";
import { chosen, type Initiative } from "../src/steps/initiate.ts";
import type { Identity } from "../src/core/types.ts";
import { rememberChannel, surveyChannels } from "../src/store/channelRegistry.ts";
import { loadThinking, writeThinking, loadThinkingHistory } from "../src/store/thinkingStore.ts";
import { appendMessage } from "../src/store/channelStore.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import { tempWorkingDir, testConfig } from "./helpers/fixtures.ts";
import type { ChannelSurvey } from "../src/store/channelRegistry.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const channel = (over: Partial<ChannelSurvey> = {}): ChannelSurvey => ({
  id: "cli",
  name: "#deploys",
  silentMs: 4 * HOUR,
  agentHasSpoken: true,
  messagesSinceAgentSpoke: 3,
  trailingAgentMessages: 0,
  messages: 20,
  ...over,
});

const paths = async () => {
  const { dir, cleanup } = await tempWorkingDir();
  cleanups.push(cleanup);
  const p = resolvePaths(dir);
  await ensurePaths(p);
  return p;
};

const person = (over: Partial<Identity> = {}): Identity => ({
  id: "olav",
  displayName: "olav",
  aliases: [],
  summary: "Wants the answer first.",
  lastSeenAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  ...over,
});

describe("who the agent may speak to unprompted", () => {
  const gate = async (
    channels: ChannelSurvey[],
    over: Record<string, unknown> = {},
    extra: {
      last?: string;
      identities?: Identity[];
      impressions?: Map<string, number>;
      perTarget?: Map<string, string>;
    } = {},
  ) => {
    const base = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    const config = {
      ...base,
      session: { ...base.session, initiative: { ...base.session.initiative, ...over } },
    };
    return eligibleTargets({
      config,
      channels,
      identities: extra.identities ?? [],
      impressionCounts: extra.impressions ?? new Map(),
      lastInitiatedAt: extra.last,
      lastPerTarget: extra.perTarget ?? new Map(),
    });
  };

  it("offers a room that has been quiet a few hours", async () => {
    expect((await gate([channel()])).eligible).toHaveLength(1);
  });

  // --- The ladder ------------------------------------------------------------
  // How much silence excuses speaking depends on who has been doing the talking.
  // A flat cutoff does both things wrong: it blocks the agent from picking up a
  // conversation it has a place in, and lets it monologue where nobody answered.

  it("lets it speak into a live conversation when somebody else spoke last", async () => {
    const live = channel({ silentMs: 60_000, trailingAgentMessages: 0 });
    expect((await gate([live])).eligible).toHaveLength(1);
  });

  it("refuses a live conversation it had the last word in", async () => {
    const live = channel({ silentMs: 60_000, trailingAgentMessages: 1 });
    expect((await gate([live])).eligible).toEqual([]);
  });

  it("lets it follow its own last message once the hour is up", async () => {
    // One unanswered message is not a monologue, and an hour has passed.
    const lull = channel({ silentMs: 2 * HOUR, trailingAgentMessages: 1 });
    expect((await gate([lull])).eligible).toHaveLength(1);
  });

  it("refuses a third in a row after an hour", async () => {
    const lull = channel({ silentMs: 2 * HOUR, trailingAgentMessages: 2 });
    expect((await gate([lull])).eligible).toEqual([]);
  });

  it("treats six hours as a fresh start, whoever spoke last", async () => {
    // Hours have gone by. Following its own message is reopening a subject
    // rather than talking over anybody.
    const stale = channel({ silentMs: 8 * HOUR, trailingAgentMessages: 3 });
    expect((await gate([stale])).eligible).toHaveLength(1);
  });

  it("refuses one that has been dead for a fortnight", async () => {
    // The guard that is easy to leave out: the survey sorts by silence, so
    // without an upper bound the deadest channel on record is permanently the
    // most eligible one.
    expect((await gate([channel({ silentMs: 30 * DAY })])).eligible).toEqual([]);
  });

  it("refuses a room it has never spoken in", async () => {
    expect((await gate([channel({ agentHasSpoken: false })])).eligible).toEqual([]);
  });



  it("holds every channel during the cooldown, not just the one it used", async () => {
    // Per-channel would let an agent with six rooms open six conversations in
    // the same quiet hour, each one locally reasonable.
    const recent = new Date(Date.now() - HOUR).toISOString();
    const result = await gate([channel({ id: "a" }), channel({ id: "b" })], {}, { last: recent });
    expect(result.eligible).toEqual([]);
    expect(result.blocked).toContain("cooldown");
  });

  it("lets it speak again once the cooldown has passed", async () => {
    const old = new Date(Date.now() - 12 * HOUR).toISOString();
    expect((await gate([channel()], {}, { last: old })).eligible).toHaveLength(1);
  });

  it("says nothing at all when the feature is off", async () => {
    const result = await gate([channel()], { enabled: false });
    expect(result.eligible).toEqual([]);
    expect(result.blocked).toContain("off");
  });
});

describe("writing to people, not just rooms", () => {
  it("offers somebody it has an impression of", async () => {
    const result = await gateFor([], [person()], new Map([["olav", 4]]));
    expect(result.eligible.map((t) => t.ref)).toEqual([dmRef("olav")]);
    // What it knows about them travels with the target: it is most of what
    // decides whether writing to them is welcome.
    expect(result.eligible[0]?.summary).toContain("answer first");
  });

  it("refuses somebody it has merely seen speak", async () => {
    // An impression means several exchanges of noticing. Without one, the agent
    // would be writing to a name in a log.
    expect((await gateFor([], [person()], new Map())).eligible).toEqual([]);
  });

  it("refuses somebody who stopped talking a month ago", async () => {
    // The DM equivalent of `max_silent_ms`, and the same trap: without it the
    // least active contact on file is permanently the most eligible.
    const gone = person({ lastSeenAt: new Date(Date.now() - 60 * DAY).toISOString() });
    expect((await gateFor([], [gone], new Map([["olav", 4]]))).eligible).toEqual([]);
  });

  it("refuses everybody when DMs are off, but still offers channels", async () => {
    const base = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    const config = {
      ...base,
      session: {
        ...base.session,
        initiative: { ...base.session.initiative, dm_enabled: false },
      },
    };
    const result = eligibleTargets({
      config,
      channels: [channel()],
      identities: [person()],
      impressionCounts: new Map([["olav", 4]]),
    });
    expect(result.eligible.map((t) => t.kind)).toEqual(["channel"]);
  });

  const gateFor = async (
    channels: ChannelSurvey[],
    identities: Identity[],
    impressions: Map<string, number>,
  ) => {
    const config = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    return eligibleTargets({ config, channels, identities, impressionCounts: impressions });
  };
});

describe("going back to the same target", () => {
  it("holds one it wrote to recently, while leaving the others open", async () => {
    // The global cooldown stops a burst; this stops the agent returning to the
    // same room every time that lapses, which reads as pestering even when each
    // message is fine.
    const config = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    const result = eligibleTargets({
      config,
      channels: [channel({ id: "a" }), channel({ id: "b" })],
      lastPerTarget: new Map([[channelRef("a"), new Date(Date.now() - DAY).toISOString()]]),
    });
    expect(result.eligible.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("the step's own answer", () => {
  const initiative = (targets: Initiative["targets"]): Initiative => ({ reasoning: "", targets });

  it("acts only on a target that has something to say to it", () => {
    expect(chosen(initiative([{ target: "channel:a", intent: "the vendor version" }]))).toHaveLength(1);
    // A ref with no intent is a target picked with nothing to tell it, which is
    // exactly what deciding and composing together was meant to prevent.
    expect(chosen(initiative([{ target: "channel:a", intent: "  " }]))).toEqual([]);
    expect(chosen(initiative([]))).toEqual([]);
  });
});

describe("the channel registry", () => {
  it("remembers the name, and keeps it when an adapter stops supplying one", async () => {
    // The CLI supplies none and Slack only on some events; an adapter that does
    // not know must not overwrite a name that was learned earlier.
    const p = await paths();
    await rememberChannel(p, "C07", "#deploys", "2026-08-14T09:00:00.000Z");
    await rememberChannel(p, "C07", undefined, "2026-08-14T10:00:00.000Z");

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.name).toBe("#deploys");
  });

  it("counts messages since the agent last spoke", async () => {
    const p = await paths();
    await rememberChannel(p, "cli", "#cli", "2026-08-14T09:00:00.000Z");
    const say = (author: string, fromAgent: boolean, n: number) =>
      appendMessage(p, "cli", {
        id: `m${n}`,
        identityId: fromAgent ? "agent" : "olav",
        author,
        text: `message ${n}`,
        at: `2026-08-14T09:0${n}:00.000Z`,
        fromAgent,
      });

    await say("olav", false, 1);
    await say("harness", true, 2);
    await say("olav", false, 3);
    await say("dana", false, 4);

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.agentHasSpoken).toBe(true);
    expect(survey?.messagesSinceAgentSpoke).toBe(2);
  });

  it("reports a room the agent has never spoken in", async () => {
    const p = await paths();
    await rememberChannel(p, "cli", "#cli", "2026-08-14T09:00:00.000Z");
    await appendMessage(p, "cli", {
      id: "m1",
      identityId: "olav",
      author: "olav",
      text: "hello?",
      at: "2026-08-14T09:00:00.000Z",
      fromAgent: false,
    });

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.agentHasSpoken).toBe(false);
    expect(survey?.messagesSinceAgentSpoke).toBe(1);
  });

  it("counts how many of the last messages are the agent's own", async () => {
    // The count the ladder turns on. `messagesSinceAgentSpoke` cannot answer it:
    // it is 0 whether the agent spoke once at the end or three times.
    const p = await paths();
    await rememberChannel(p, "cli", "#cli", "2026-08-14T09:00:00.000Z");
    const say = (author: string, fromAgent: boolean, n: number) =>
      appendMessage(p, "cli", {
        id: `m${n}`,
        identityId: fromAgent ? "agent" : "olav",
        author,
        text: `message ${n}`,
        at: `2026-08-14T09:0${n}:00.000Z`,
        fromAgent,
      });

    await say("olav", false, 1);
    await say("harness", true, 2);
    await say("harness", true, 3);

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.trailingAgentMessages).toBe(2);
    expect(survey?.messagesSinceAgentSpoke).toBe(0);
  });

  it("counts none when somebody else spoke last", async () => {
    const p = await paths();
    await rememberChannel(p, "cli", "#cli", "2026-08-14T09:00:00.000Z");
    await appendMessage(p, "cli", {
      id: "m1",
      identityId: "agent",
      author: "harness",
      text: "Node 22.",
      at: "2026-08-14T09:01:00.000Z",
      fromAgent: true,
    });
    await appendMessage(p, "cli", {
      id: "m2",
      identityId: "olav",
      author: "olav",
      text: "thanks",
      at: "2026-08-14T09:02:00.000Z",
      fromAgent: false,
    });

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.trailingAgentMessages).toBe(0);
  });

  it("finds the agent's own turns in history written by an older build", async () => {
    // Those are labelled `agent` rather than by name. A survey that missed them
    // would report the agent as never having spoken in its oldest channels.
    const p = await paths();
    await rememberChannel(p, "cli", "#cli", "2026-08-14T09:00:00.000Z");
    await appendMessage(p, "cli", {
      id: "m1",
      identityId: "agent",
      author: "agent",
      text: "Node 22.",
      at: "2026-08-14T09:00:00.000Z",
      fromAgent: true,
    });

    const [survey] = await surveyChannels(p, "harness");
    expect(survey?.agentHasSpoken).toBe(true);
  });
});

describe("the background thinking document", () => {
  it("keeps every revision and reads the latest", async () => {
    const p = await paths();
    await writeThinking(p, "first pass", "000001");
    await writeThinking(p, "changed my mind", "000002");

    expect((await loadThinking(p))?.text).toBe("changed my mind");
    expect((await loadThinking(p))?.revision).toBe(1);
    expect(await loadThinkingHistory(p)).toEqual(["first pass\n", "changed my mind\n"]);
  });

  it("refuses to replace a real revision with nothing", async () => {
    // The single outcome here that actually loses something. An unparsed
    // pondering must leave the previous revision standing.
    const p = await paths();
    await writeThinking(p, "worth keeping", "000001");
    await writeThinking(p, "   ", "000002");

    expect((await loadThinking(p))?.text).toBe("worth keeping");
    expect(await loadThinkingHistory(p)).toHaveLength(1);
  });

  it("has nothing to say before anything has been thought", async () => {
    expect(await loadThinking(await paths())).toBeUndefined();
  });
});

describe("a session that thinks, then decides whether to speak", () => {
  it("ponders into the durable document and starts nothing when it has nothing", async () => {
    const { runSession } = await import("../src/session/run.ts");
    const { maintenanceTrigger } = await import("../src/core/trigger.ts");
    const { mockOllama, reply } = await import("./helpers/mockOllama.ts");
    const { testHistory, testIdentity } = await import("./helpers/fixtures.ts");

    const p = await paths();
    const server = await mockOllama([
      reply(
        JSON.stringify({
          thinking: "Read the plan; the schema item is still the blocker.",
          carry_forward: "Importer: schema mapping is the blocker. sqlite settled.",
        }),
      ),
      reply(JSON.stringify({ reasoning: "Nothing is finished and nobody is waiting on me.", targets: [] })),
    ]);
    cleanups.push(server.close);

    const config = await testConfig(server.host, p.root);

    const result = await runSession({
      config,
      paths: p,
      trigger: maintenanceTrigger("cli", "tidying up", ["ponder", "initiate"]),
      identity: testIdentity(),
      history: testHistory(),
      initiativeTargets: [
        {
          ref: channelRef("cli"),
          kind: "channel",
          id: "cli",
          name: "#cli",
          silentMs: 4 * HOUR,
          agentHasSpoken: true,
          messagesSinceAgentSpoke: 3,
        },
      ],
    });

    expect(result.completed.map((s) => s.name)).toContain("ponder");
    expect(result.initiatives).toBeUndefined();
    // The document outlives the session; that is the whole point of it.
    expect((await loadThinking(p))?.text).toContain("schema mapping is the blocker");
  });

  it("writes one message per target, each told who else is being written to", async () => {
    // The channel is not this session's own and `runSession` has no adapter, so
    // delivery — and the instance-wide cooldown — belong to the daemon.
    const { runSession } = await import("../src/session/run.ts");
    const { maintenanceTrigger } = await import("../src/core/trigger.ts");
    const { mockOllama, reply } = await import("./helpers/mockOllama.ts");
    const { testHistory, testIdentity } = await import("./helpers/fixtures.ts");

    const p = await paths();
    const server = await mockOllama([
      reply(
        JSON.stringify({
          reasoning: "I said I would look into the vendor version, and dana is waiting on it.",
          targets: [
            { target: channelRef("deploys"), intent: "the vendor is on 22.4, not 21" },
            { target: dmRef("dana"), intent: "her migration assumption was wrong" },
          ],
        }),
      ),
      reply(JSON.stringify({ message: "That vendor version — they are on 22.4, not 21." })),
      reply(JSON.stringify({ message: "Your migration note assumed 21; they are on 22.4." })),
    ]);
    cleanups.push(server.close);
    const config = await testConfig(server.host, p.root);

    const result = await runSession({
      config,
      paths: p,
      trigger: maintenanceTrigger("cli", "tidying up", ["initiate"]),
      identity: testIdentity(),
      history: testHistory(),
      initiativeTargets: [
        {
          ref: channelRef("deploys"),
          kind: "channel",
          id: "deploys",
          name: "#deploys",
          silentMs: 4 * HOUR,
          agentHasSpoken: true,
          messagesSinceAgentSpoke: 6,
        },
        {
          ref: dmRef("dana"),
          kind: "dm",
          id: "dana",
          name: "dana",
          silentMs: 2 * HOUR,
          agentHasSpoken: true,
          messagesSinceAgentSpoke: 0,
          summary: "Wants to be corrected bluntly.",
        },
      ],
    });

    // One message each, paired with the target it was written for.
    expect(result.initiatives?.map((i) => [i.kind, i.id])).toEqual([
      ["channel", "deploys"],
      ["dm", "dana"],
    ]);
    expect(result.initiatives?.[0]?.message).toContain("22.4");
    expect(result.initiatives?.[1]?.message).toContain("migration");

    // Each was told about the other, so neither is composed as though it were
    // the only message being sent.
    const prompts = server.requests.map((r) => r.body.messages?.[0]?.content ?? "");
    expect(prompts.find((t) => t.includes("writing to **#deploys**"))).toContain("dana");
    expect(prompts.find((t) => t.includes("writing to **dana**"))).toContain("#deploys");
  });

  it("cannot name a target it was not offered", async () => {
    // Compiled from the refs that passed the countable gates, so a model cannot
    // reason its way into a room, or to a person, the harness ruled out.
    const { initiate } = await import("../src/steps/initiate.ts");
    const { z } = await import("zod");
    const config = await testConfig("http://127.0.0.1:1", "/tmp/unused");
    const schema = initiate.buildSchema(config, {
      initiativeTargets: [{ ref: channelRef("deploys") }, { ref: dmRef("dana") }],
    } as never);
    const { properties } = z.toJSONSchema(schema) as unknown as {
      properties: { targets: { items: { properties: { target: { enum?: string[] } } } } };
    };
    expect(properties.targets.items.properties.target.enum).toEqual([
      "channel:deploys",
      "dm:dana",
    ]);
  });
})
