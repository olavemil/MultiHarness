import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";

/**
 * When the agent last started a conversation nobody asked for.
 *
 * **Instance-wide, not per channel**, and that is the whole point of storing it
 * here rather than beside a channel: the cooldown has to span rooms, or an agent
 * with six of them opens six conversations in the same quiet hour and each one
 * looks locally reasonable. The same failure weighted participation exists to
 * damp, one level up.
 *
 * Durable rather than in-memory for the ordinary reason: a daemon restart must
 * not hand the agent a fresh budget to interrupt people with.
 */

const FILE = "initiative.json";

export interface InitiativeRecord {
  /** When the agent last started anything with anybody. Drives the global cooldown. */
  at?: string;
  /**
   * Target ref -> when that target was last written to.
   *
   * Separate from `at` because they stop different things. The global cooldown
   * stops a burst; this stops the agent going back to the same room or person
   * every time the global one lapses, which reads as pestering even when each
   * message is individually fine.
   */
  targets?: Record<string, string>;
}

export async function loadInitiative(paths: Paths): Promise<InitiativeRecord> {
  try {
    return JSON.parse(await readFile(path.join(paths.root, FILE), "utf8")) as InitiativeRecord;
  } catch {
    return {};
  }
}

/** Records one delivered message. Called after the send, never before. */
export async function recordInitiative(paths: Paths, targetRef: string): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const at = new Date().toISOString();
  const existing = await loadInitiative(paths);
  const record: InitiativeRecord = {
    at,
    targets: { ...existing.targets, [targetRef]: at },
  };
  await writeFile(path.join(paths.root, FILE), JSON.stringify(record, null, 2), "utf8");
}

/** Target ref -> when it was last written to, for the per-target cooldown. */
export const lastPerTarget = (record: InitiativeRecord): ReadonlyMap<string, string> =>
  new Map(Object.entries(record.targets ?? {}));
