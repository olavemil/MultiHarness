import { describe, expect, it } from "vitest";
import {
  addWork,
  completeWork,
  describeWork,
  emptyWorkList,
  nextWork,
  recordAttempt,
  WorkKind,
  type WorkItem,
} from "../src/v2/work.ts";
import { loadWorkList, saveWorkList } from "../src/v2/workStore.ts";
import { compose } from "../src/v2/compose/section.ts";
import { scheduleWork } from "../src/v2/steps/scheduleWork.ts";
import { doWork } from "../src/v2/steps/work.ts";
import { onBackground, onMessage } from "../src/v2/pipeline.ts";
import type { StepInput } from "../src/v2/steps/input.ts";
import type { Effects } from "../src/v2/steps/types.ts";
import { resolvePaths } from "../src/store/paths.ts";
import { tempWorkingDir } from "./helpers/fixtures.ts";

const principal = { agentName: "galatea", persona: "a terse agent", channelName: "#deploys" };
const origin = { session: "000001", channelId: "C1", at: "2026-01-01T00:00:00Z" };
const policy = { maxAttempts: 3 };

function input(over: Partial<StepInput> = {}): StepInput {
  return { principal, history: [], completed: [], impressions: [], ...over };
}

/** Collects everything a step's `apply` asks for. */
function recorder() {
  const work: { kind: string; task: string }[] = [];
  const notes: Record<string, string> = {};
  const knowledge: string[] = [];
  const fx: Effects = {
    impression: () => {},
    knowledge: (_t, text) => {
      knowledge.push(text);
    },
    requeue: () => {},
    note: (k, v) => {
      notes[k] = v;
    },
    work: (kind, task) => {
      work.push({ kind, task });
    },
  };
  return { fx, work, notes, knowledge };
}

describe("the work list", () => {
  it("merges two proposals of the same kind by concatenation", () => {
    // The rule from restructuring.md, chosen over v1's embedding-similarity
    // merge because it carries no unmeasured threshold.
    const list = addWork(addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "Do task 1", origin }]), [
      { kind: WorkKind.research, task: "Do task 2", origin },
    ]);

    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.task).toBe("Do task 1\nDo task 2");
  });

  it("keeps different kinds apart", () => {
    const list = addWork(emptyWorkList(), [
      { kind: WorkKind.research, task: "look up the vendor version", origin },
      { kind: WorkKind.reason, task: "think about the migration order", origin },
    ]);
    expect(list.items.map((i) => i.kind)).toEqual(["research", "reason"]);
  });

  it("does not absorb new text into an item already being attempted", () => {
    // Otherwise the attempt count stops meaning attempts at *that* task.
    let list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "first", origin }]);
    list = recordAttempt(list, list.items[0]!, policy);
    list = addWork(list, [{ kind: WorkKind.research, task: "second", origin }]);

    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.task).toBe("first");
    expect(list.items[1]?.task).toBe("second");
  });

  it("ignores an empty task and a duplicate line", () => {
    let list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "  ", origin }]);
    expect(list.items).toHaveLength(0);

    list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "same", origin }]);
    list = addWork(list, [{ kind: WorkKind.research, task: "same", origin }]);
    expect(list.items[0]?.task).toBe("same");
  });
});

describe("draining", () => {
  it("yields to messages, which is what makes an endless loop safe", () => {
    const list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "a", origin }]);
    expect(nextWork(list, policy, true)).toBeUndefined();
    expect(nextWork(list, policy, false)?.task).toBe("a");
  });

  it("drops an item once it is out of attempts", () => {
    // The closing rule: a task list nothing can close becomes a standing
    // instruction the agent cannot escape.
    let list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "impossible", origin }]);

    for (let n = 0; n < policy.maxAttempts; n++) {
      const item = nextWork(list, policy, false);
      expect(item).toBeDefined();
      list = recordAttempt(list, item as WorkItem, policy);
    }

    expect(list.items).toHaveLength(0);
    expect(nextWork(list, policy, false)).toBeUndefined();
  });

  it("moves on to the next item rather than retrying one for ever", () => {
    let list = addWork(emptyWorkList(), [
      { kind: WorkKind.research, task: "hard", origin },
      { kind: WorkKind.reason, task: "easy", origin },
    ]);

    for (let n = 0; n < policy.maxAttempts; n++) {
      list = recordAttempt(list, list.items.find((i) => i.kind === "research")!, policy);
    }

    expect(nextWork(list, policy, false)?.task).toBe("easy");
  });

  it("removes an item the agent reported finished", () => {
    const list = addWork(emptyWorkList(), [{ kind: WorkKind.research, task: "done", origin }]);
    expect(completeWork(list, list.items[0]!).items).toHaveLength(0);
  });

  it("renders nothing at all when the list is empty", () => {
    expect(describeWork(emptyWorkList())).toBeUndefined();
  });
});

describe("the work list on disk", () => {
  it("round-trips, so the loop survives a restart", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    try {
      const paths = resolvePaths(dir);
      const list = addWork(emptyWorkList(), [{ kind: WorkKind.write, task: "note it down", origin }]);

      await saveWorkList(paths, list);
      const loaded = await loadWorkList(paths);

      expect(loaded.items).toEqual(list.items);
    } finally {
      await cleanup();
    }
  });

  it("returns an empty list rather than failing when there is no file", async () => {
    const { dir, cleanup } = await tempWorkingDir();
    try {
      expect((await loadWorkList(resolvePaths(dir))).items).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("drops an item whose kind the harness cannot dispatch", async () => {
    // Otherwise it sits in the list being skipped for ever, which looks exactly
    // like the loop being stuck.
    const { dir, cleanup } = await tempWorkingDir();
    try {
      const paths = resolvePaths(dir);
      await saveWorkList(paths, {
        items: [
          { kind: "invent" as WorkItem["kind"], task: "x", origin, attempts: 0 },
          { kind: WorkKind.reason, task: "keep", origin, attempts: 0 },
        ],
      });

      const loaded = await loadWorkList(paths);
      expect(loaded.items.map((i) => i.task)).toEqual(["keep"]);
    } finally {
      await cleanup();
    }
  });
});

describe("schedule_work — the step v1 has no equivalent of", () => {
  it("closes the message pipeline, so the agent says what it wants next", () => {
    expect(onMessage.map((s) => s.step.name).at(-1)).toBe("schedule_work");
  });

  it("proposes nothing when it says there is nothing worth doing", () => {
    // The gate is enforced in code, not trusted to the prompt: a model that
    // says "nothing" and then lists three things has contradicted itself, and
    // the boolean it committed to first is the answer.
    const { fx, work } = recorder();
    scheduleWork.apply?.(
      { anythingWorthDoing: false, reason: "finished with", work: [{ kind: "research", task: "x" }] },
      fx,
    );
    expect(work).toEqual([]);
  });

  it("passes work through when there is some", () => {
    const { fx, work } = recorder();
    scheduleWork.apply?.(
      {
        anythingWorthDoing: true,
        reason: "left a question open",
        work: [{ kind: "research", task: "which release the vendor is on" }],
      },
      fx,
    );
    expect(work).toEqual([{ kind: "research", task: "which release the vendor is on" }]);
  });

  it("proposes nothing on a parse failure", () => {
    const { fx, work } = recorder();
    scheduleWork.apply?.(scheduleWork.fallback(), fx);
    expect(work).toEqual([]);
  });

  it("shows what is already queued so it does not propose it again", () => {
    const pendingWork = addWork(emptyWorkList(), [
      { kind: WorkKind.research, task: "which release the vendor is on", origin },
    ]);
    const text = compose(scheduleWork.context(input({ message: "thanks", pendingWork })));

    expect(text).toContain("## Already on your list");
    expect(text).toContain("which release the vendor is on");
  });

  it("omits that section entirely when nothing is queued", () => {
    const text = compose(scheduleWork.context(input({ message: "thanks" })));
    expect(text).not.toContain("Already on your list");
    expect(text).not.toMatch(/\$\{/);
  });
});

describe("the background pipeline", () => {
  it("never runs a working step without an item", () => {
    // A background session with nothing to do opens a directory and spends a
    // reasoning call concluding it had nothing to do.
    const idle = input();
    expect(onBackground.filter((s) => s.when?.(idle) ?? true).map((s) => s.step.name)).toEqual([
      "schedule_work",
    ]);
  });

  it("works the item, then decides what is next", () => {
    const working = input({ currentWork: { kind: "research", task: "look it up", attempts: 0 } });
    expect(onBackground.filter((s) => s.when?.(working) ?? true).map((s) => s.step.name)).toEqual([
      "work",
      "schedule_work",
    ]);
  });

  it("tells the agent how many times it has already tried", () => {
    const text = compose(
      doWork.context(input({ currentWork: { kind: "research", task: "hard one", attempts: 2 } })),
    );
    expect(text).toContain("2 time(s) already");
  });

  it("says nothing about attempts on the first one", () => {
    const text = compose(
      doWork.context(input({ currentWork: { kind: "research", task: "hard one", attempts: 0 } })),
    );
    expect(text).not.toContain("time(s) already");
  });

  it("reports unfinished on a parse failure, so the cap decides rather than a guess", () => {
    expect(doWork.fallback().finished).toBe(false);
  });

  it("routes a durable fact through the gatekeeper rather than writing it", () => {
    const { fx, knowledge, notes } = recorder();
    doWork.apply?.({ finished: true, findings: "f", learned: "vendor ships 22.4" }, fx);

    expect(knowledge).toEqual(["vendor ships 22.4"]);
    expect(notes.finished).toBe("true");
  });
});
