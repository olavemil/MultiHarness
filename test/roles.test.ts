import { describe, expect, it } from "vitest";
import { defaultTimeoutFor, hostFor, resolveRole, resolveStepModel } from "../src/model/roles.ts";
import { Config } from "../src/config/schema.ts";

/**
 * Hand-built rather than `testConfig()`: that helper loads the real
 * `config/default.toml`, whose own `[roles.*] backend` default is a live
 * decision under active change (it flipped to `"omlx"` mid-experiment) —
 * coupling this suite to it would make these tests measure the shipped file
 * instead of the resolution logic. `shippedConfig.test.ts` already covers
 * "does the real file parse"; this covers "does resolution do the right thing
 * given a config", independent of what the file currently says.
 */
function baseConfig(overrides: Record<string, unknown> = {}) {
  return Config.parse({
    working_dir: "/tmp/x",
    agent: { name: "harness" },
    ollama: { host: "http://ollama.local:11434" },
    context: {},
    roles: {
      // Explicit rather than relying on the schema default: that default is a
      // live experiment (currently "omlx") and this fixture wants a role that
      // is unambiguously on ollama regardless of which way it is set.
      fast: { model: "phi4:latest", backend: "ollama" },
      reasoning: { model: "qwen3.6:27b", backend: "omlx" },
    },
    session: {
      reflect_step: "reflect",
      read_step: "read",
      stance_step: "stance",
      selectable_steps: [],
      schedule_step: "schedule",
      respond_step: "respond",
      closing_steps: ["summarize"],
    },
    ...overrides,
  });
}

/**
 * `[roles.*] backend` selects `hostFor`/`embedFor`/`chatFor`'s dispatch, and
 * `resolveRole` is where a misconfigured role — `backend: "omlx"` with no
 * `[omlx]` table — is caught, the same way a placeholder model is: at
 * resolution, not at config load, since a role nothing uses yet should not
 * block startup.
 */
describe("backend resolution", () => {
  it("resolves an ollama-backed role to the ollama host", () => {
    const config = baseConfig();
    const role = resolveRole(config, "fast");
    expect(role.backend).toBe("ollama");
    expect(hostFor(config, role)).toBe("http://ollama.local:11434");
  });

  it("refuses an omlx-backed role when [omlx] is not configured", () => {
    const config = baseConfig();
    expect(() => resolveRole(config, "reasoning")).toThrowError(/\[omlx\] is not configured/);
  });

  it("routes an omlx-backed role to the omlx host once configured", () => {
    const config = baseConfig({ omlx: { host: "http://omlx.local:8080" } });
    const role = resolveRole(config, "reasoning");
    expect(role.backend).toBe("omlx");
    expect(hostFor(config, role)).toBe("http://omlx.local:8080");
  });

  it("uses each backend's own default request timeout, absent a step override", () => {
    const config = baseConfig({
      omlx: { host: "http://omlx.local:8080", request_timeout_ms: 60_000 },
    });
    expect(defaultTimeoutFor(config, "ollama")).toBe(config.ollama.request_timeout_ms);
    expect(defaultTimeoutFor(config, "omlx")).toBe(60_000);

    const resolved = resolveStepModel(config, "reason", "reasoning");
    expect(resolved.timeoutMs).toBe(60_000);
  });

  it("still lets a step's own timeout_ms win over the backend default", () => {
    const config = baseConfig({
      omlx: { host: "http://omlx.local:8080", request_timeout_ms: 60_000 },
      steps: { reason: { timeout_ms: 12_345 } },
    });
    const resolved = resolveStepModel(config, "reason", "reasoning");
    expect(resolved.timeoutMs).toBe(12_345);
  });
});
