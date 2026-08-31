import type { Config } from "../config/schema.ts";
import { PLACEHOLDER_MODEL } from "../config/schema.ts";
import type { OptionValue } from "./transport.ts";
import { chat as ollamaChat, embed as ollamaEmbed } from "./ollama.ts";
import { chat as omlxChat, embed as omlxEmbed } from "./omlx.ts";

export type Backend = "ollama" | "omlx";

export interface ResolvedRole {
  name: string;
  model: string;
  backend: Backend;
  keepAlive?: number | string;
  think?: boolean;
  noTools: boolean;
  /** One call at a time on this model. Keyed by model id, so roles sharing weights share a queue. */
  exclusive: boolean;
  options: Record<string, OptionValue>;
}

export interface ResolvedStepModel {
  role: ResolvedRole;
  timeoutMs: number;
  /** Final allowlist after the role's `no_tools` veto has been applied. */
  tools: readonly string[];
}

/**
 * Binds a role name to a concrete model.
 *
 * Fails here rather than at config load: a role that is configured but never
 * used should not block startup, but a role that is *used* while still set to
 * a placeholder must fail immediately and say so.
 */
export function resolveRole(config: Config, roleName: string): ResolvedRole {
  const role = config.roles[roleName];
  if (!role) {
    const known = Object.keys(config.roles).join(", ") || "(none)";
    throw new Error(`Model role "${roleName}" is not configured. Configured roles: ${known}.`);
  }
  if (role.model === PLACEHOLDER_MODEL) {
    throw new Error(
      `Model role "${roleName}" is still set to ${PLACEHOLDER_MODEL}. ` +
        `Set a real ollama tag (see \`ollama list\`) in config/default.toml ` +
        `or in the file $MULTIHARNESS_CONFIG points at.`,
    );
  }
  if (role.backend === "omlx" && !config.omlx) {
    throw new Error(
      `Model role "${roleName}" is set to backend "omlx", but [omlx] is not configured. ` +
        `Add an [omlx] table with a host, in config/default.toml or the file ` +
        `$MULTIHARNESS_CONFIG points at.`,
    );
  }

  return {
    name: roleName,
    model: role.model,
    backend: role.backend,
    ...(role.keep_alive !== undefined ? { keepAlive: role.keep_alive } : {}),
    ...(role.think !== undefined ? { think: role.think } : {}),
    noTools: role.no_tools,
    exclusive: role.exclusive,
    options: role.options,
  };
}

/**
 * Which module's `chat()`/`embed()` a resolved role's calls go through.
 * Centralised here rather than duplicated in `call.ts`, `toolLoop.ts`, and
 * every direct `embed()` caller, so a third backend is one dispatch table to
 * extend instead of four.
 */
export const chatFor = (role: ResolvedRole) => (role.backend === "omlx" ? omlxChat : ollamaChat);
export const embedFor = (role: ResolvedRole) => (role.backend === "omlx" ? omlxEmbed : ollamaEmbed);

/** The host a resolved role's calls go to, chosen by its `backend`. */
export function hostFor(config: Config, role: ResolvedRole): string {
  if (role.backend === "omlx") {
    // resolveRole already refused to produce an "omlx" role without this
    // table present, so the assertion here is restating a checked invariant,
    // not skipping a check.
    return (config.omlx as NonNullable<Config["omlx"]>).host;
  }
  return config.ollama.host;
}

/** The backend's own default request timeout, absent a per-step override. */
export function defaultTimeoutFor(config: Config, backend: Backend): number {
  if (backend === "omlx") return (config.omlx as NonNullable<Config["omlx"]>).request_timeout_ms;
  return config.ollama.request_timeout_ms;
}

/**
 * Resolves the model a step will actually run on, applying config overrides
 * over the step's own declared defaults.
 *
 * A role marked `no_tools` empties the allowlist regardless of what the step or
 * its config asked for — the constraint is enforced by the harness, not left to
 * the prompt to respect.
 */
export function resolveStepModel(
  config: Config,
  stepName: string,
  defaultRole: string,
  defaultTools: readonly string[] = [],
): ResolvedStepModel {
  const stepConfig = config.steps[stepName];
  const role = resolveRole(config, stepConfig?.role ?? defaultRole);

  const requested = stepConfig?.tools ?? defaultTools;
  const tools = role.noTools ? [] : requested;

  const think = stepConfig?.think ?? role.think;

  return {
    role: {
      ...role,
      options: { ...role.options, ...(stepConfig?.options ?? {}) },
      ...(think !== undefined ? { think } : {}),
    },
    timeoutMs: stepConfig?.timeout_ms ?? defaultTimeoutFor(config, role.backend),
    tools,
  };
}
