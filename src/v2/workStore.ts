import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "../store/paths.ts";
import { emptyWorkList, type WorkItem, type WorkList } from "./work.ts";
import { WORK_KINDS } from "./values.ts";

/**
 * The work list on disk.
 *
 * **Per instance, not per channel**, which is the one place this departs from
 * how v1 files things. A plan is per channel because it is a commitment made in
 * a room; background work is what the agent wants to do, and wanting something
 * is not a property of a room. Each item still records the channel it came
 * from, so work that escalates into a plan can be filed in the right place.
 *
 * Rewritten whole rather than appended. The list is small, bounded by the
 * attempt cap, and the interesting history — what was proposed and what came of
 * it — is already in the session directories, which are immutable. A second
 * append-only log of the same facts would be a second thing to keep consistent.
 */

const FILE = "work.json";

const listPath = (paths: Paths): string => path.join(paths.root, FILE);

export async function loadWorkList(paths: Paths): Promise<WorkList> {
  try {
    const raw = await readFile(listPath(paths), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return { items: readItems(parsed) };
  } catch {
    // A missing or corrupt list is an empty list. Refusing to start over a bad
    // file would take the whole instance down for the least important state it
    // holds, and the agent will simply propose work again.
    return emptyWorkList();
  }
}

export async function saveWorkList(paths: Paths, list: WorkList): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  await writeFile(listPath(paths), `${JSON.stringify({ items: list.items }, null, 2)}\n`, "utf8");
}

/**
 * Reads items defensively.
 *
 * Anything unrecognised is dropped rather than trusted: a kind the harness
 * cannot dispatch would sit in the list for ever being skipped, which looks
 * exactly like the loop being stuck.
 */
function readItems(parsed: unknown): WorkItem[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const kinds: readonly string[] = WORK_KINDS;
  const out: WorkItem[] = [];

  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;

    const kind = item.kind;
    const task = item.task;
    if (typeof kind !== "string" || !kinds.includes(kind)) continue;
    if (typeof task !== "string" || task.trim() === "") continue;

    const origin = (item.origin ?? {}) as Record<string, unknown>;
    out.push({
      kind: kind as WorkItem["kind"],
      task,
      attempts: typeof item.attempts === "number" && item.attempts >= 0 ? item.attempts : 0,
      origin: {
        session: typeof origin.session === "string" ? origin.session : "",
        channelId: typeof origin.channelId === "string" ? origin.channelId : "",
        at: typeof origin.at === "string" ? origin.at : "",
      },
    });
  }

  return out;
}
