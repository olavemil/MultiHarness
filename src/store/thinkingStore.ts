import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";

/**
 * What the agent has been thinking about in the background, between
 * conversations.
 *
 * **Cross-channel, unlike a plan.** A plan is a commitment in one room; this is
 * the agent's view of its own situation across all of them — what is in
 * progress, what it keeps returning to, what it thinks about the state of its
 * own work. Filing it per channel would fragment exactly the thing that makes it
 * worth having.
 *
 * **Append-only revisions, latest read.** `thinking_0.md`, `thinking_1.md`, …
 * with `thinking.json` pointing at the current one, the same arrangement as
 * plans and for the same reason: this is a document a model rewrites about
 * itself, read by later sessions and never checked against anything. A version
 * that overwrote its predecessor would lose the record of how it drifted, and
 * drift is the failure to watch for in every loop of this shape.
 *
 * There is no closing here, and that is deliberate rather than an oversight. A
 * plan needs `fulfilled`/`abandoned` because an open one *directs* work; this
 * directs nothing. Each revision simply supersedes the last, so a stale thought
 * costs one revision's attention and then stops mattering.
 */

const DIR = "thinking";
const POINTER = "thinking.json";

const thinkingDir = (paths: Paths): string => path.join(paths.root, DIR);

export interface Thinking {
  /** The current text, as the last revision left it. */
  text: string;
  /** Which revision this is, from 0. */
  revision: number;
  /** The session that wrote it. */
  session: string;
  at: string;
}

export async function loadThinking(paths: Paths): Promise<Thinking | undefined> {
  try {
    const raw = await readFile(path.join(thinkingDir(paths), POINTER), "utf8");
    const pointer = JSON.parse(raw) as { revision: number; session: string; at: string };
    const text = await readFile(
      path.join(thinkingDir(paths), `thinking_${pointer.revision}.md`),
      "utf8",
    );
    // Trimmed on the way out: the trailing newline is a file-format detail, and
    // every caller either renders this into a prompt or compares it.
    return { text: text.trim(), revision: pointer.revision, session: pointer.session, at: pointer.at };
  } catch {
    return undefined;
  }
}

/** Every revision, oldest first. Nothing reads this yet; it is the audit trail. */
export async function loadThinkingHistory(paths: Paths): Promise<string[]> {
  try {
    const files = (await readdir(thinkingDir(paths)))
      .filter((f) => /^thinking_\d+\.md$/.test(f))
      .sort((a, b) => revisionOf(a) - revisionOf(b));
    return Promise.all(files.map((f) => readFile(path.join(thinkingDir(paths), f), "utf8")));
  } catch {
    return [];
  }
}

/**
 * Writes the next revision and moves the pointer.
 *
 * Sealed `0444` like step output: a revision is a record of what was thought at
 * a moment, and something that can be edited afterwards is not that.
 */
export async function writeThinking(
  paths: Paths,
  text: string,
  session: string,
): Promise<Thinking> {
  const body = text.trim();
  // An empty revision would supersede a real one with nothing, which is the
  // single outcome here that actually loses something.
  if (body === "") {
    const existing = await loadThinking(paths);
    if (existing) return existing;
  }

  const dir = thinkingDir(paths);
  await mkdir(dir, { recursive: true });
  const previous = await loadThinking(paths);
  const revision = previous ? previous.revision + 1 : 0;
  const at = new Date().toISOString();

  const file = path.join(dir, `thinking_${revision}.md`);
  await writeFile(file, `${body}\n`, "utf8");
  await chmod(file, 0o444);
  await writeFile(path.join(dir, POINTER), JSON.stringify({ revision, session, at }), "utf8");

  return { text: body, revision, session, at };
}

const revisionOf = (file: string): number => Number(file.match(/(\d+)/)?.[1] ?? 0);
