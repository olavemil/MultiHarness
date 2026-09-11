import { describe, expect, it } from "vitest";
import { compose, demote, document } from "../src/v2/compose/section.ts";
import { presentAgentAndChannel } from "../src/v2/compose/fragments.ts";
import { ModelRole } from "../src/v2/values.ts";
import { restate } from "../src/v2/steps/restate.ts";
import { reflect } from "../src/v2/steps/reflect.ts";
import { onMessage } from "../src/v2/pipeline.ts";
import type { StepInput } from "../src/v2/steps/input.ts";

const principal = { agentName: "galatea", persona: "a terse agent", channelName: "#deploys" };

function input(over: Partial<StepInput> = {}): StepInput {
  return {
    principal,
    history: [],
    completed: [],
    impressions: [],
    ...over,
  };
}

describe("compose", () => {
  it("joins nested arrays tightly and the top level with a blank line", () => {
    expect(compose(["# Title", ["## Head", "body"]])).toBe("# Title\n\n## Head\nbody");
  });

  it("omits an absent section entirely — no heading, no placeholder, no blank line", () => {
    const absent: string | undefined = undefined;
    expect(compose(["# Title", absent && ["## Head", absent], "after"])).toBe("# Title\n\nafter");
  });

  it("drops a section whose body is whitespace", () => {
    expect(compose(["# Title", ["## Head", "   "]])).toBe("# Title\n\n## Head");
  });

  it("keeps a fenced block intact", () => {
    expect(compose([["## Message", "```", "hi", "```"]])).toBe("## Message\n```\nhi\n```");
  });
});

describe("demote", () => {
  it("pushes headings below the level they are nested under", () => {
    expect(demote("# Reflection\n\ntext", 2)).toBe("### Reflection\n\ntext");
  });

  it("leaves a heading inside fenced code alone", () => {
    expect(demote("```\n# not a heading\n```", 2)).toBe("```\n# not a heading\n```");
  });

  it("clamps at h6 rather than emitting an invalid level", () => {
    expect(demote("##### deep", 3)).toBe("###### deep");
  });
});

describe("document", () => {
  it("nests a sealed document without breaking the outer structure", () => {
    // The v1 bug: reflect's own `# Reflection` H1 injected into another prompt.
    const out = compose(["# Outer", document("## Prior reflection", "# Reflection\n\nit went fine")]);
    expect(out).toBe("# Outer\n\n## Prior reflection\n\n### Reflection\n\nit went fine");
    // No H1 survives inside the body.
    expect(out.split("\n").filter((l) => /^# /.test(l))).toEqual(["# Outer"]);
  });

  it("disappears when the body is empty or whitespace", () => {
    expect(document("## Prior", undefined)).toBeUndefined();
    expect(document("## Prior", "  \n ")).toBeUndefined();
  });
});

describe("values read as bounded", () => {
  it("exposes dotted access and the matching type", () => {
    const role: ModelRole = ModelRole.reasoning;
    expect(role).toBe("reasoning");
  });
});

describe("steps compose their whole prompt", () => {
  it("renders no placeholder prose when everything optional is absent", () => {
    const text = compose(restate.context(input({ message: "what about the migration?" })));

    expect(text).toContain("# Task");
    expect(text).toContain("what about the migration?");
    // Nothing invented for the absent pieces.
    expect(text).not.toContain("Recent messages");
    expect(text).not.toContain("correction");
    expect(text).not.toMatch(/\(no |\(none|\(nothing/);
  });

  it("picks its framing by naming a fragment, not by declaring a voice", () => {
    const text = compose(restate.context(input({ message: "hi" })));
    expect(text).toContain(presentAgentAndChannel.onlooker(principal));
    expect(text).not.toContain(presentAgentAndChannel.agent(principal));
  });

  it("gives reflect the settled restatement rather than making it infer one", () => {
    const text = compose(
      reflect.context(
        input({
          message: "no, the other one",
          completed: [{ step: "restate", content: "# Request\n\nWhich migration to run first." }],
        }),
      ),
    );

    expect(text).toContain("## What it is asking");
    expect(text).toContain("Which migration to run first.");
    // Demoted under its heading — the sealed H1 does not survive.
    expect(text).not.toContain("\n# Request");
  });

  it("leaves no template variable unsubstituted, because there are none", () => {
    const text = compose(reflect.context(input({ message: "hi", prior: { review: "went ok" } })));
    expect(text).not.toMatch(/\$\{/);
  });
});

describe("pipeline order is explicit", () => {
  it("runs restate before reflect", () => {
    const names = onMessage.map((s) => s.step.name);
    expect(names).toEqual(["restate", "reflect", "schedule_work"]);
    // The ordering the experiment exists to test, asserted as a relation so
    // adding a step later cannot make it pass vacuously.
    expect(names.indexOf("restate")).toBeLessThan(names.indexOf("reflect"));
  });

  it("skips each stage on the countable condition it declares", () => {
    const first = input({ message: "hello" });
    const running = input({
      message: "hello",
      history: [{ author: "ada", text: "earlier" }],
      prior: { review: "went ok" },
    });

    // A first message in a channel needs no restatement and has nothing to
    // reflect on; the agent is still asked what it wants to do next.
    expect(onMessage.filter((s) => s.when?.(first) ?? true).map((s) => s.step.name)).toEqual([
      "schedule_work",
    ]);
    expect(onMessage.filter((s) => s.when?.(running) ?? true).map((s) => s.step.name)).toEqual([
      "restate",
      "reflect",
      "schedule_work",
    ]);
  });
});

describe("effects are declared on the step", () => {
  it("routes reflect's impression and correction through the capability object", async () => {
    const impressions: string[] = [];
    const notes: Record<string, string> = {};

    await reflect.apply?.(
      {
        assessment: "a",
        signal: "dissatisfied",
        correction: "they meant the other migration",
        recommendations: [],
        impression: "wants short answers",
      },
      {
        impression: (t) => {
          impressions.push(t);
        },
        knowledge: () => {},
        requeue: () => {},
        note: (k, v) => {
          notes[k] = v;
        },
        work: () => {},
      },
    );

    expect(impressions).toEqual(["wants short answers"]);
    expect(notes.correction).toBe("they meant the other migration");
  });

  it("writes nothing when there is nothing to record", async () => {
    const impressions: string[] = [];
    await reflect.apply?.(reflect.fallback(), {
      impression: (t) => {
        impressions.push(t);
      },
      knowledge: () => {},
      requeue: () => {},
      note: () => {},
      work: () => {},
    });
    expect(impressions).toEqual([]);
  });
});
