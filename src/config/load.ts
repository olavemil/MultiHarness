import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { Config, PLACEHOLDER_MODEL } from "./schema.ts";
import { deepMerge } from "./merge.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Default config shipped with the repo. Holds no agent or session data. */
export const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "config", "default.toml");

/**
 * The instance directory: one agent's config, knowledge, files, and sessions.
 *
 * Everything that distinguishes one agent from another lives here, so a second
 * instance is `MULTIHARNESS_HOME=~/agents/other npm run dev` and nothing else.
 */
export function instanceHome(): string {
  const configured = process.env["MULTIHARNESS_HOME"];
  if (configured) return path.resolve(expandHome(configured));

  const root = path.join(homedir(), ".multiharness");
  // A config directly in the root is a single unnamed instance.
  if (existsSync(path.join(root, "config.toml"))) return root;

  // `npm run init` creates one directory per agent, named after the bot. With
  // exactly one, there is nothing to disambiguate; with several, the daemon
  // must be told which, because guessing would start the wrong agent.
  const instances = readdirSafe(root).filter((entry) =>
    existsSync(path.join(root, entry, "config.toml")),
  );
  if (instances.length === 1) return path.join(root, instances[0] as string);
  if (instances.length > 1) {
    throw new Error(
      `Several agent instances exist under ${root}: ${instances.join(", ")}. ` +
        `Set MULTIHARNESS_HOME to the one you mean.`,
    );
  }
  return root;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export const instanceConfigPath = (home = instanceHome()): string =>
  path.join(home, "config.toml");

function expandHome(target: string): string {
  if (target === "~") return homedir();
  return target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
}

/**
 * Layered, most general first:
 *
 *   1. `config/default.toml` from the repo — conventions and measured defaults
 *   2. `$MULTIHARNESS_HOME/config.toml` — this instance's identity and settings
 *   3. `$MULTIHARNESS_CONFIG` — an explicit override, for experiments
 *
 * `working_dir` defaults to the instance directory, so an instance is
 * self-contained: one directory holds its config and everything it accumulates.
 *
 * Placeholder model ids are not rejected here — a role that is configured but
 * never used should not block startup. Resolution fails loudly instead, at the
 * point the role is actually requested (see `model/roles.ts`).
 */
export async function loadConfig(
  overridePath: string | undefined = process.env["MULTIHARNESS_CONFIG"],
  /**
   * Which instance to read. Explicit in tests and evals so a suite never picks
   * up whatever agent happens to be configured on the machine running it —
   * that made the test suite depend on the developer's `~/.multiharness`.
   */
  home: string = instanceHome(),
): Promise<Config> {
  let merged = parseToml(await readFile(DEFAULT_CONFIG_PATH, "utf8")) as Record<string, unknown>;

  // The instance directory is the default working directory; an explicit
  // `working_dir` in either layer below still wins.
  merged = deepMerge(merged, { working_dir: home });

  const instance = await readIfPresent(instanceConfigPath(home));
  if (instance) merged = deepMerge(merged, parseToml(instance) as Record<string, unknown>);

  if (overridePath) {
    merged = deepMerge(
      merged,
      parseToml(await readFile(overridePath, "utf8")) as Record<string, unknown>,
    );
  }

  const parsed = Config.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    const sources = [DEFAULT_CONFIG_PATH, instanceConfigPath(home), overridePath]
      .filter(Boolean)
      .join(" + ");
    throw new Error(`Invalid config (${sources}):\n${issues}`);
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

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}
