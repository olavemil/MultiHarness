import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * The working directory lives outside the repo and holds everything the agent
 * accumulates. The repo holds code, prompts, and default config only.
 */
export interface Paths {
  root: string;
  /** K/V knowledge store. Unused until the gatekeeper lands. */
  knowledge: string;
  /** The agent's own sandbox filesystem. */
  files: string;
  /** One directory per session. */
  sessions: string;
  /** Per-channel history. */
  channels: string;
  identities: string;
}

export function resolvePaths(workingDir: string): Paths {
  const root = expandHome(workingDir);
  return {
    root,
    knowledge: path.join(root, "knowledge"),
    files: path.join(root, "files"),
    sessions: path.join(root, "sessions"),
    channels: path.join(root, "channels"),
    identities: path.join(root, "identities"),
  };
}

export async function ensurePaths(paths: Paths): Promise<void> {
  await Promise.all(
    [paths.knowledge, paths.files, paths.sessions, paths.channels, paths.identities].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
}

function expandHome(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return path.join(homedir(), target.slice(2));
  return path.resolve(target);
}
