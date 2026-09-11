import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { KNOWN_STEP_NAMES } from "../src/steps/registry.ts";
import { KNOWN_TOOL_NAMES } from "../src/tools/registry.ts";

/**
 * What `config/default.toml` actually parses to.
 *
 * Written after a silent misparse: `[session.continuation]` and
 * `[session.maintenance]` were added *inside* the `[session]` block, and a TOML
 * table header ends the previous table's scope — so six plain keys written after
 * them belonged to a sub-table instead. Zod strips unknown keys, so they
 * vanished without a word.
 *
 * **Five of the six had schema defaults identical to the file**, which is why it
 * went unnoticed for as long as it did; only `reply_target` ever showed a
 * symptom, by silently flipping to `false` and turning off a feature this repo
 * documents as on-with-evidence. A default that duplicates the config file hides
 * the config file failing to load.
 */
describe("the shipped configuration", () => {
  const hermetic = () => loadConfig(undefined, path.join(tmpdir(), "multiharness-no-instance"));

  it("parses every [session] key as written, not as a schema default", async () => {
    const { session } = await hermetic();

    expect(session.restate_step).toBe("restate");
    // Suggestions, not a constraint — but every one still has to say when it
    // fits, or it reaches the prompt as an emoji name with no situation
    // attached, which is worse than not offering it.
    expect(Object.keys(session.acknowledgements).length).toBeGreaterThan(1);
    for (const when of Object.values(session.acknowledgements)) {
      expect(when.trim()).not.toBe("");
    }
    // Both fallbacks have to be sane on their own: they are what a parse
    // failure sends, with no model judgement behind them.
    expect(session.acknowledge_emoji).not.toBe("");
    expect(session.working_emoji).not.toBe("");
    // `reflect` has to be allowed as maintenance work, or a reaction that
    // arrives after the channel goes quiet is never read by anything.
    expect(session.maintenance.steps).toContain(session.reflect_step);
    expect(session.debrief_step).toBe("debrief");
    expect(session.plan_step).toBe("plan");
    expect(session.acknowledge_emoji).toBe("+1");
    expect(session.impression_threshold).toBe(5);
    expect(session.max_wallclock_ms).toBe(900_000);
    expect(session.selectable_steps).toEqual(["research", "reason", "draft", "plan", "initiate"]);
  });

  it("ships the v2 experiment off, and reads it from the file", async () => {
    const config = await hermetic();

    // The one flag deliberately shipped off, against "everything ships
    // enabled": the point is running v1 and v2 side by side, and defaulting it
    // on leaves nothing to compare against.
    //
    // Asserted here because it is a *top-level* key, which makes it the exact
    // shape this suite was written for: written below a [table] header it would
    // belong to that table, Zod would strip it, and the `false` default would
    // hide the loss completely.
    expect(config.v2).toBe(false);
    expect(Object.keys(config)).toContain("v2");
  });

  it("keeps the sub-tables separate from the keys around them", async () => {
    const { session } = await hermetic();

    // One session at a time across the daemon. A schema default that duplicates
    // the file is exactly what hides the file failing to load, so it is asserted
    // against what the file says.
    expect(session.turn.size).toBe(1);
    expect(session.continuation.enabled).toBe(true);
    expect(session.maintenance.enabled).toBe(true);
    expect(session.maintenance.idle_ms).toBe(300_000);
    expect(session.participation.enabled).toBe(true);
    expect(session.participation.interject_delay_ms).toBe(4_000);
  });

  it("names only steps that exist", async () => {
    const { session, steps } = await hermetic();
    const named = [
      session.reflect_step,
      session.read_step,
      session.stance_step,
      session.schedule_step,
      session.respond_step,
      session.restate_step,
      session.debrief_step,
      session.plan_step,
      ...session.selectable_steps,
      ...session.closing_steps,
      ...session.maintenance.steps,
      ...session.continuation.steps,
      ...Object.keys(steps),
    ].filter((name) => name !== "");

    // `update`, `reply_target`, and `knowledge_gatekeeper` are model callers
    // configured like steps without being registered ones.
    const callers = ["update", "reply_target", "knowledge_gatekeeper"];
    for (const name of named) {
      if (callers.includes(name)) continue;
      expect(KNOWN_STEP_NAMES, `"${name}" is configured but not registered`).toContain(name);
    }
  });

  it("grants only tools that exist", async () => {
    const { steps } = await hermetic();
    for (const [step, config] of Object.entries(steps)) {
      for (const tool of config.tools ?? []) {
        expect(KNOWN_TOOL_NAMES, `${step} grants unknown tool "${tool}"`).toContain(tool);
      }
    }
  });

  it("binds every role a step asks for", async () => {
    const { steps, roles } = await hermetic();
    for (const [step, config] of Object.entries(steps)) {
      if (config.role) {
        expect(Object.keys(roles), `${step} wants role "${config.role}"`).toContain(config.role);
      }
    }
  });
});
