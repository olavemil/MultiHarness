import type { Config } from "../config/schema.ts";
import { PLACEHOLDER_MODEL } from "../config/schema.ts";
import type { OptionValue } from "./ollama.ts";

export interface ResolvedRole {
  name: string;
  model: string;
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

  return {
    name: roleName,
    model: role.model,
    ...(role.keep_alive !== undefined ? { keepAlive: role.keep_alive } : {}),
    ...(role.think !== undefined ? { think: role.think } : {}),
    noTools: role.no_tools,
    exclusive: role.exclusive,
    options: role.options,
  };
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
    timeoutMs: stepConfig?.timeout_ms ?? config.ollama.request_timeout_ms,
    tools,
  };
}
