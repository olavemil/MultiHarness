import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";

/**
 * Session directories are `NNNNNN-<timestamp>` — sortable, human-readable, and
 * addressable by number, which is how tools will look up prior sessions.
 */
export interface SessionHandle {
  number: number;
  id: string;
  dir: string;
  traceDir: string;
}

const SESSION_DIR = /^(\d{6})-/;

export async function createSession(paths: Paths, at: Date = new Date()): Promise<SessionHandle> {
  const next = (await highestSessionNumber(paths)) + 1;
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const id = `${String(next).padStart(6, "0")}-${stamp}`;
  const dir = path.join(paths.sessions, id);
  const traceDir = path.join(dir, "trace");

  await mkdir(traceDir, { recursive: true });
  return { number: next, id, dir, traceDir };
}

async function highestSessionNumber(paths: Paths): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(paths.sessions);
  } catch {
    return 0;
  }

  return entries.reduce((highest, entry) => {
    const match = SESSION_DIR.exec(entry);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

/**
 * The mutable file a running step streams into. Lives under `trace/` precisely
 * because it is not step output — it becomes output only when sealed.
 */
export function workingFilePath(session: SessionHandle, stepName: string): string {
  return path.join(session.traceDir, `${stepName}.partial`);
}

/**
 * Writes a step's output once, at step end, and makes it read-only.
 *
 * Read-only is enforced by the filesystem rather than by convention: every tool
 * the agent is ever given inherits the guarantee without having to respect it.
 */
export async function sealStep(
  session: SessionHandle,
  outputFile: string,
  content: string,
): Promise<string> {
  const target = path.join(session.dir, outputFile);
  await writeFile(target, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await chmod(target, 0o444);
  return target;
}
