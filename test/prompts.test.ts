import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { DEFAULT_PROMPTS_DIR, listVariants, loadPrompt } from "../src/prompts/load.ts";
import { render, templateVariables } from "../src/prompts/render.ts";
import { prepareModelStep } from "../src/session/prepareStep.ts";
import { KNOWN_STEP_NAMES, getStep } from "../src/steps/registry.ts";
import type { ModelStep } from "../src/steps/types.ts";
import { testHistory, testIdentity, testMessage } from "./helpers/fixtures.ts";

describe("render", () => {
  it("substitutes every placeholder", () => {
    expect(render("Hi ${name}, you are ${role}.", { name: "Ada", role: "operator" })).toBe(
      "Hi Ada, you are operator.",
    );
  });

  it("throws rather than shipping a literal placeholder to the model", () => {
    expect(() => render("Hi ${name}, ${missing}", { name: "Ada" })).toThrowError(/missing/);
  });

  it("tolerates extra variables the template does not use", () => {
    expect(render("Hi ${name}", { name: "Ada", unused: "x" })).toBe("Hi Ada");
  });

  it("reports the variables a template needs", () => {
    expect(templateVariables("${a} ${b} ${a}")).toEqual(["a", "b"]);
  });
});

describe("loadPrompt", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "multiharness-prompts-"));
    await writeFile(path.join(dir, "react_1.md"), "variant one", "utf8");
    await writeFile(path.join(dir, "react_2.md"), "variant two", "utf8");
    await writeFile(path.join(dir, "respond.md"), "single", "utf8");
    // Must not be picked up as a `react` variant.
    await writeFile(path.join(dir, "reaction.md"), "unrelated", "utf8");
  });

  it("finds only the variants belonging to a step", async () => {
    expect(await listVariants(dir, "react")).toEqual(["react_1.md", "react_2.md"]);
    expect(await listVariants(dir, "respond")).toEqual(["respond.md"]);
  });

  it("records which variant was selected", async () => {
    const first = await loadPrompt("react", { dir, rng: () => 0 });
    expect(first.variantId).toBe("react_1");
    expect(first.text).toBe("variant one");

    const second = await loadPrompt("react", { dir, rng: () => 0.99 });
    expect(second.variantId).toBe("react_2");
    expect(second.text).toBe("variant two");
  });

  it("reaches every variant across repeated selections", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add((await loadPrompt("react", { dir })).variantId);
    }
    expect([...seen].sort()).toEqual(["react_1", "react_2"]);
  });

  it("handles a single-variant prompt", async () => {
    expect((await loadPrompt("respond", { dir })).variantId).toBe("respond");
  });

  it("names the step and the expected filenames when nothing matches", async () => {
    await expect(loadPrompt("research", { dir })).rejects.toThrowError(/research\.md/);
  });
});

/**
 * Every shipped prompt, against the blocks its step actually declares.
 *
 * `render` throws on an unsupplied variable, so a template that grows a
 * `${block}` its step does not declare fails only when that step next runs —
 * possibly on a path no test covers. Assembling every variant of every
 * registered step here turns that into a compile-time-ish check.
 */
describe("shipped prompts", () => {
  it("references only variables its step supplies", async () => {
    const warn = console.warn;
    console.warn = () => {};
    const config = await loadConfig(
      undefined,
      path.join(tmpdir(), "multiharness-no-instance"),
    ).finally(() => {
      console.warn = warn;
    });

    const blockInput = {
      message: testMessage(),
      history: testHistory(),
      identity: testIdentity(),
      completed: [],
      prior: {
        id: "000001-prior",
        number: 1,
        review: "r",
        summary: "s",
        reflection: "f",
        request: "q",
        debrief: "",
      },
      impressions: [],
    };

    for (const name of KNOWN_STEP_NAMES) {
      const step = getStep(name);
      if (step.kind !== "model") continue;

      for (const file of await listVariants(DEFAULT_PROMPTS_DIR, name)) {
        await expect(
          prepareModelStep({
            step: step as ModelStep<unknown>,
            config,
            blockInput,
            mention: undefined,
            variant: file.replace(/\.md$/, ""),
          }),
          `${file} references a variable its step does not declare`,
        ).resolves.toBeTruthy();
      }
    }
  });
});
