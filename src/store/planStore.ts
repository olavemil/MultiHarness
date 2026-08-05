import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSandboxPath } from "../tools/files/safePath.ts";
import type { Paths } from "./paths.ts";
import { slug } from "./slug.ts";

/**
 * The durable, cross-session plan: what the agent is working on here, surviving
 * across sessions rather than being re-derived from the last twelve messages.
 *
 * **Per channel**, like history, reflection, and the last-session pointer. A
 * channel therefore has at most one active plan, which is a real limitation —
 * two goals in one room displace each other — and a deliberate one: per-goal
 * plans need a key nothing else in the system has, and there is no evidence yet
 * that one plan per channel is the binding constraint. The layout below is a
 * directory of revisions, so adding a goal key later does not mean rewriting
 * what is already stored.
 *
 * **Revisions are append-only.** `plan_0.md`, `plan_1.md`, … are each sealed
 * read-only on write and never edited. A plan that overwrote itself would lose
 * the record of what changed and why, which is the same reason impressions sit
 * beside an identity rather than inside it — and here it matters more, because a
 * plan directs future work rather than merely describing a person.
 *
 * The name was freed on purpose: in-session step selection is `schedule`, sealed
 * to `schedule.md`, so `plan` and `plan_N.md` mean the durable document and
 * nothing else.
 */

export type PlanStatus = "active" | "fulfilled" | "abandoned";

/**
 * What one named artifact looked like when a revision was written.
 *
 * Recorded with the revision so the next iteration can diff against it. This is
 * what turns "did anything happen?" from a claim into a measurement: a plan step
 * can say an item is done, but it cannot make a file exist by saying so.
 */
export interface ArtifactState {
  path: string;
  exists: boolean;
  size: number;
}

export interface Plan {
  /** Revision number; `plan_N.md`. */
  revision: number;
  status: PlanStatus;
  /** One line: what this plan is for. */
  goal: string;
  /** What is left to do, in order. Empty once fulfilled. */
  outstanding: string[];
  /**
   * Files under the agent's `files/` directory that this plan exists to
   * produce. Naming them is what makes progress checkable from outside the
   * model's own account of it.
   *
   * Optional: plenty of plans are deliberative and produce a decision rather
   * than a file. A plan that declares none falls back to counting closed items.
   */
  artifacts: string[];
  /** Those artifacts as they stood when this revision was written. */
  artifactState: ArtifactState[];
  /** What changed in this revision, and why. Empty on the first. */
  changed: string;
  /** Session that wrote this revision. */
  session: string;
  at: string;
}

const POINTER = "plan.json";
const PLANS_DIR = "plans";

const planDir = (paths: Paths, channelId: string): string =>
  path.join(paths.channels, slug(channelId), PLANS_DIR);

/**
 * The plan a channel is currently working to, or `undefined` when there is none
 * or the last revision closed it.
 *
 * A fulfilled or abandoned plan reads as absent on purpose. **A plan nothing can
 * close becomes a standing instruction the agent cannot escape** — every later
 * session would keep being told to work on something finished months ago.
 */
export async function loadPlan(paths: Paths, channelId: string): Promise<Plan | undefined> {
  try {
    const raw = await readFile(path.join(planDir(paths, channelId), POINTER), "utf8");
    const plan = JSON.parse(raw) as Plan;
    return plan.status === "active" ? plan : undefined;
  } catch {
    return undefined;
  }
}

/** Every revision including closed ones, for inspecting how a plan drifted. */
export async function loadPlanHistory(paths: Paths, channelId: string): Promise<string[]> {
  const dir = planDir(paths, channelId);
  try {
    const files = (await readdir(dir)).filter((f) => /^plan_\d+\.md$/.test(f)).sort();
    return await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")));
  } catch {
    return [];
  }
}

/**
 * Writes the next revision and moves the pointer.
 *
 * Called only by the harness, only for the configured plan step's output. No
 * tool writes plans, so a step cannot revise one on its own authority — the same
 * arrangement as knowledge writes going through the gatekeeper, and enforced the
 * way `no_tools` is rather than by asking a prompt nicely.
 */
export async function writePlanRevision(
  paths: Paths,
  channelId: string,
  next: Omit<Plan, "revision" | "at">,
): Promise<Plan> {
  const dir = planDir(paths, channelId);
  await mkdir(dir, { recursive: true });

  const existing = (await readdir(dir).catch(() => []))
    .map((f) => /^plan_(\d+)\.md$/.exec(f)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const revision = existing.length > 0 ? Math.max(...existing) + 1 : 0;

  const plan: Plan = { ...next, revision, at: new Date().toISOString() };

  const outstanding =
    plan.outstanding.length > 0
      ? plan.outstanding.map((item) => `- ${item}`).join("\n")
      : "_(nothing outstanding)_";

  const artifacts =
    plan.artifactState.length > 0
      ? plan.artifactState
          .map((a) => `- \`${a.path}\` — ${a.exists ? `${a.size} bytes` : "not written yet"}`)
          .join("\n")
      : "_(none named)_";

  const body = [
    `# Plan ${revision} — ${plan.status}`,
    "",
    plan.goal,
    "",
    "## Outstanding",
    "",
    outstanding,
    "",
    "## Artifacts",
    "",
    artifacts,
    "",
    "## What changed",
    "",
    plan.changed.trim() || "_(first revision)_",
    "",
    "---",
    "",
    `_Session ${plan.session}, ${plan.at}_`,
  ].join("\n");

  const file = path.join(dir, `plan_${revision}.md`);
  await writeFile(file, `${body}\n`, "utf8");
  // Read-only for the same reason sealed step output is: a revision is a record
  // of what was decided, and a record that can be edited is not one.
  await (await import("node:fs/promises")).chmod(file, 0o444);

  await writeFile(path.join(dir, POINTER), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

/**
 * Measures the named artifacts as they are right now.
 *
 * Paths go through the same validator the file tools use — a plan is written by
 * a model, so an artifact name is untrusted text like any other, and a plan
 * naming `../../etc/passwd` must not turn into a stat of it. An unsafe name is
 * reported as absent rather than throwing: something that cannot be written can
 * never show progress either, which is the honest reading.
 */
export async function snapshotArtifacts(
  filesRoot: string,
  artifacts: readonly string[],
): Promise<ArtifactState[]> {
  return Promise.all(
    artifacts.map(async (name) => {
      try {
        const resolved = await resolveSandboxPath(filesRoot, name);
        const info = await stat(resolved);
        return { path: name, exists: info.isFile(), size: info.isFile() ? info.size : 0 };
      } catch {
        return { path: name, exists: false, size: 0 };
      }
    }),
  );
}
