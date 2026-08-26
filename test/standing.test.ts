import { afterEach, describe, expect, it } from "vitest";
import { computeSituation } from "../src/core/situation.ts";
import { agentStanding, describeStanding } from "../src/core/standing.ts";
import { embeddings, mockOllama } from "./helpers/mockOllama.ts";
import { testConfig, testHistory, tempWorkingDir } from "./helpers/fixtures.ts";
import { appendMessage, lastContribution, readRecent } from "../src/store/channelStore.ts";
import { lastContribution as lastContributionBlock } from "../src/context/blocks/lastContribution.ts";
import { ensurePaths, resolvePaths } from "../src/store/paths.ts";
import type { ChannelMessage } from "../src/core/types.ts";
import type { Config } from "../src/config/schema.ts";

/**
 * Standing: whether a message continues a subject the agent has itself spoken
 * on, as distinct from being addressed.
 *
 * The test fixture turns this off, because it calls the embed model and
 * `mockOllama` serves whatever a test queued. This file is what stops that
 * making the feature untested everywhere — the same job `runs respond with the
 * knowledge tools it ships with` does for tool allowlists.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const said = (author: string, text: string): ChannelMessage => ({
  id: `${author}-${text.slice(0, 6)}`,
  identityId: author,
  author,
  text,
  at: new Date().toISOString(),
  fromAgent: author === "agent",
});

/** Unit vectors, so cosine is exactly the value each case is about. */
const NEAR = [1, 0.1];
const FAR = [0, 1];

async function configWith(vectors: number[][], over: Partial<Config["session"]> = {}) {
  const { dir, cleanup } = await tempWorkingDir();
  const server = await mockOllama([embeddings(vectors)]);
  cleanups.push(cleanup, server.close);

  const base = await testConfig(server.host, dir);
  return {
    server,
    config: {
      ...base,
      session: {
        ...base.session,
        standing: { ...base.session.standing, enabled: true },
        ...over,
      },
    } as Config,
  };
}

describe("measuring standing", () => {
  it("marks a message on the agent's own subject", async () => {
    const { config } = await configWith([NEAR, NEAR]);
    const standing = await agentStanding(
      config,
      [said("agent", "Functionalism says the substrate is irrelevant."), said("olav", "hm")],
      "so is continuity what does the real work there?",
    );

    expect(standing?.related).toBe(true);
    expect(standing?.nearest).toContain("Functionalism");
  });

  it("marks one that is not", async () => {
    const { config } = await configWith([NEAR, FAR]);
    const standing = await agentStanding(
      config,
      [said("agent", "Node 22 or newer.")],
      "did the March invoicing run go out?",
    );

    expect(standing?.related).toBe(false);
  });

  it("asks nothing when the agent has not spoken here", async () => {
    // Nothing to compare against, and no call worth making.
    const { config, server } = await configWith([NEAR]);
    expect(await agentStanding(config, [said("olav", "morning")], "anyone about?")).toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });

  it("asks nothing when the feature is off", async () => {
    const { config, server } = await configWith([NEAR], {});
    const off = {
      ...config,
      session: { ...config.session, standing: { ...config.session.standing, enabled: false } },
    } as Config;

    expect(await agentStanding(off, [said("agent", "hello")], "hi")).toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });

  it("sends the message and the agent's turns in one request", async () => {
    // A round trip per turn would put this back on the latency budget that ruled
    // out asking a large model the same question.
    const { config, server } = await configWith([NEAR, NEAR, NEAR]);
    await agentStanding(
      config,
      [said("agent", "one"), said("olav", "x"), said("agent", "two")],
      "three",
    );

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toContain("/api/embed");
  });

  it("compares only against the agent's own turns", async () => {
    const { config, server } = await configWith([NEAR, NEAR]);
    await agentStanding(config, [said("agent", "mine"), said("olav", "theirs")], "next");

    const input = (server.requests[0]?.body as unknown as { input: string[] }).input;
    expect(input).toEqual(["next", "mine"]);
  });

  it("stays absent rather than claiming 'unrelated' when the model cannot be reached", async () => {
    // The distinction that matters: an unreachable embed model must not assert
    // that nothing is the agent's subject, or one outage silences the agent
    // everywhere and reads as a decision it made.
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const base = await testConfig("http://127.0.0.1:1", dir);
    const config = {
      ...base,
      ollama: { ...base.ollama, request_timeout_ms: 500 },
      session: {
        ...base.session,
        standing: { ...base.session.standing, enabled: true },
      },
    } as Config;

    expect(await agentStanding(config, [said("agent", "hello")], "hi")).toBeUndefined();
    expect(describeStanding(undefined)).toContain("Not established");
  });
});

describe("standing routes the situation", () => {
  // A third routing axis rather than another paragraph in an existing fragment.
  // Measured three times: appending a second test after a terminal gate weakens
  // the gate, and `open-question-recent` paid for it every time.
  const history = [
    said("agent", "Functionalism says the substrate is irrelevant."),
    said("galatea", "organisation without continuity seems thin"),
    said("olav", "that is the part I keep getting stuck on"),
  ];
  const agent = { name: "harness", aliases: ["@harness"] };

  it("routes to the own-subject fragment when the message continues the agent's", () => {
    expect(computeSituation("does continuity do the real work?", history, agent, 8, undefined, true).id)
      .toBe("none_recent_own");
    expect(computeSituation("@galatea does continuity do it?", history, agent, 8, undefined, true).id)
      .toBe("other_recent_own");
  });

  it("leaves the ordinary fragments alone otherwise", () => {
    expect(computeSituation("unrelated question", history, agent, 8, undefined, false).id)
      .toBe("none_recent");
    expect(computeSituation("unrelated question", history, agent, 8, undefined, undefined).id)
      .toBe("none_recent");
  });

  it("does not apply where the agent has said nothing", () => {
    // `absent` means it has no subject here to continue, so a true reading would
    // be a contradiction — and the fragment would open by asserting a thread
    // that does not exist.
    const others = [said("olav", "morning"), said("galatea", "hello")];
    expect(computeSituation("carry on then", others, agent, 8, undefined, true).id).toBe(
      "none_absent",
    );
  });

  it("does not apply when the agent is the last to have spoken", () => {
    // `immediate` is already engaged; it needs no help deciding that.
    const engaged = [...testHistory(), said("agent", "Node 22 or newer.")];
    expect(computeSituation("thanks", engaged, agent, 8, undefined, true).id).toBe(
      "none_immediate",
    );
  });
});

describe("what the agent last actually said", () => {
  // The second half of the same failure. `reflect` opens by judging how the
  // previous session landed — but a session that declined to reply *is* the
  // previous one, so after a run of declines it has only its own silence to
  // read, and starts assessing whether anyone remarked on it.
  it("reaches past the message window to find it", async () => {
    // The case this exists for: an agent that has been quiet for a while has its
    // last contribution *outside* the window, so tailing N messages would answer
    // "you have said nothing" exactly when the answer matters most.
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const paths = resolvePaths(dir);
    await ensurePaths(paths);

    await appendMessage(paths, "cli", { ...said("agent", "Functionalism, roughly."), fromAgent: true });
    for (let i = 0; i < 60; i++) {
      await appendMessage(paths, "cli", said("olav", `chatter ${i}`));
    }

    const last = await lastContribution(paths, "cli");
    expect(last?.text).toBe("Functionalism, roughly.");
    expect(last?.messagesSince).toBe(60);
    expect(await readRecent(paths, "cli", 40)).toHaveLength(40);
  });

  it("is absent in a channel the agent has never spoken in", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    cleanups.push(cleanup);
    const paths = resolvePaths(dir);
    await ensurePaths(paths);
    await appendMessage(paths, "cli", said("olav", "morning"));

    expect(await lastContribution(paths, "cli")).toBeUndefined();
  });

  it("tells reflect how long the silence has run", async () => {
    const quiet = lastContributionBlock.resolve({
      lastContribution: { text: "Node 22 or newer.", at: "", messagesSince: 7 },
    } as never);
    expect(quiet).toContain("Node 22 or newer.");
    expect(quiet).toContain("7 messages ago");
    expect(quiet).toContain("did not speak in the exchange just before");
    // Third person: its only reader judges the agent's work as somebody else's,
    // and a block body cannot be swapped by voice the way its heading can.
    expect(quiet).not.toContain("you");

    const recent = lastContributionBlock.resolve({
      lastContribution: { text: "Node 22 or newer.", at: "", messagesSince: 1 },
    } as never);
    // Absent, not a note saying so. The previous session's own artifacts
    // already carry that reply, and repeating it primes `satisfied` — measured:
    // `new-subject` and `prior-reflection-carried` both fell to 2/3.
    expect(recent).toBeUndefined();
  });

  it("says plainly when there is nothing, rather than rendering empty", async () => {
    // An empty block reads to a model as an answer that said nothing.
    expect(lastContributionBlock.resolve({} as never)).toContain("not said anything");
  });
});
