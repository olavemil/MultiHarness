import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { Config, PLACEHOLDER_MODEL } from "./schema.ts";
import { deepMerge } from "./merge.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Default config shipped with the repo. Holds no agent or session data. */
export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "config", "default.toml");

/**
 * Loads `config/default.toml`, then deep-merges an optional user config over it.
 *
 * Placeholder model ids are not rejected here — a role that is configured but
 * never used should not block startup. Resolution fails loudly instead, at the
 * point the role is actually requested (see `model/roles.ts`).
 */
export async function loadConfig(
  overridePath: string | undefined = process.env["MULTIHARNESS_CONFIG"],
): Promise<Config> {
  const base = parseToml(await readFile(DEFAULT_CONFIG_PATH, "utf8")) as Record<string, unknown>;

  const merged = overridePath
    ? deepMerge(base, parseToml(await readFile(overridePath, "utf8")) as Record<string, unknown>)
    : base;

  const parsed = Config.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    const source = overridePath ? `${DEFAULT_CONFIG_PATH} + ${overridePath}` : DEFAULT_CONFIG_PATH;
    throw new Error(`Invalid config (${source}):\n${issues}`);
  }

  warnOnPlaceholders(parsed.data);
  return parsed.data;
}

function warnOnPlaceholders(config: Config): void {
  const unset = Object.entries(config.roles)
    .filter(([, role]) => role.model === PLACEHOLDER_MODEL)
    .map(([name]) => name);

  if (unset.length > 0) {
    console.warn(
      `[config] roles still set to ${PLACEHOLDER_MODEL}: ${unset.join(", ")}. ` +
        `Set real ollama tags in config/default.toml or $MULTIHARNESS_CONFIG ` +
        `before running a step that uses them.`,
    );
  }
}
