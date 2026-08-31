import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Finding the agents on this machine.
 *
 * An agent is a directory. `npm run init` creates one per bot under
 * `~/.multiharness/`, named after the bot — which is why the directory name is
 * what `npm run dev -- <name>` matches: it is the name the operator already
 * knows the agent by, and it needs no config to be read to resolve it.
 */

export interface InstanceRef {
  /** Directory name. What the operator types to select this one. */
  name: string;
  home: string;
}

/**
 * Where the agents live.
 *
 * `MULTIHARNESS_ROOT` names the whole *set*; `MULTIHARNESS_HOME` names exactly
 * one and still wins, because the two answer different questions. The root
 * exists for the container, where `$HOME` is whatever the image says and a
 * numeric non-root user can resolve `homedir()` to `/` — so a mount path has to
 * be stated rather than inferred.
 */
export const instanceRoot = (): string => {
  const configured = process.env["MULTIHARNESS_ROOT"];
  return configured ? path.resolve(expandHome(configured)) : path.join(homedir(), ".multiharness");
};

export function expandHome(target: string): string {
  if (target === "~") return homedir();
  return target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target;
}

/**
 * Every instance this daemon could host, in a stable order.
 *
 * `MULTIHARNESS_HOME` still names exactly one, because it means "this agent" —
 * pointing it at a directory and getting every sibling as well would be a
 * surprise, and it is how a single instance is run from anywhere on disk.
 */
export function discoverInstances(root: string = instanceRoot()): InstanceRef[] {
  const configured = process.env["MULTIHARNESS_HOME"];
  if (configured) {
    const home = path.resolve(expandHome(configured));
    return [{ name: path.basename(home), home }];
  }

  // A config directly in the root is a single unnamed instance.
  if (existsSync(path.join(root, "config.toml"))) {
    return [{ name: path.basename(root), home: root }];
  }

  return readdirSafe(root)
    .filter((entry) => existsSync(path.join(root, entry, "config.toml")))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, home: path.join(root, name) }));
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Narrows the discovered set to the names asked for on the command line.
 *
 * An unknown name is an error naming what does exist, never a silent skip:
 * `npm run dev -- galatae` starting nothing at all, or worse starting everything
 * else, is the shape of mistake that costs an afternoon.
 */
export function selectInstances(all: InstanceRef[], names: string[]): InstanceRef[] {
  if (names.length === 0) return all;

  const known = new Map(all.map((ref) => [ref.name, ref]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const available = all.length > 0 ? all.map((r) => r.name).join(", ") : "(none)";
    throw new Error(
      `No such instance: ${unknown.join(", ")}. Available: ${available}. ` +
        `Run \`npm run init\` to create one.`,
    );
  }

  // Deduplicated, and in discovery order rather than argument order, so the
  // startup log reads the same however the arguments were typed.
  const wanted = new Set(names);
  return all.filter((ref) => wanted.has(ref.name));
}
