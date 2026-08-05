import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./types.ts";

/**
 * Reading the agent's own past sessions — spec'd in harness.md as "tools access
 * to read a given step of the previous session, or look up session by number".
 *
 * Sealed step output is immutable and already on disk, so this adds no new write
 * surface: it is the introspection half of the sandbox, and the thing that lets
 * `reason` look at what it concluded last time rather than re-deriving it.
 *
 * **No path is ever constructed from model input.** A session number is matched
 * against the directory listing and a step name against the files actually in
 * that session. Traversal is impossible because nothing supplied is joined to a
 * path — it is compared against what exists.
 */

const CAP = 4_000;
const cap = (text: string): string =>
  text.length <= CAP ? text : `${text.slice(0, CAP)}\n[… truncated]`;

const SESSION_DIR = /^(\d{6})-/;

/** Session directories, newest first, with their numbers. */
async function listSessions(root: string): Promise<{ number: number; id: string }[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  return entries
    .map((id) => ({ id, match: SESSION_DIR.exec(id) }))
    .filter((e): e is { id: string; match: RegExpExecArray } => e.match !== null)
    .map((e) => ({ number: Number(e.match[1]), id: e.id }))
    .sort((a, b) => b.number - a.number);
}

export const sessionList: ToolDefinition<{ limit?: number | undefined }> = {
  name: "session_list",
  description:
    "List the agent's recent sessions by number, newest first, with the outputs each one " +
    "left. Use this to find a session worth opening before calling session_read.",
  parameters: z.object({ limit: z.number().int().positive().optional() }),
  readOnly: true,

  run: async ({ limit }, ctx) => {
    const sessions = (await listSessions(ctx.sessions)).slice(0, limit ?? 10);
    if (sessions.length === 0) return "There are no earlier sessions.";

    const lines = await Promise.all(
      sessions.map(async (s) => {
        const files = (await readdir(path.join(ctx.sessions, s.id)).catch(() => []))
          .filter((f) => f.endsWith(".md"))
          .sort();
        return `- ${s.number}: ${files.join(", ") || "(nothing sealed)"}`;
      }),
    );
    return cap(lines.join("\n"));
  },
};

export const sessionRead: ToolDefinition<{ session: number; output: string }> = {
  name: "session_read",
  description:
    "Read one sealed output from an earlier session — for example output 'response.md' from " +
    "session 12. Session output is immutable, so this is always what was actually produced.",
  parameters: z.object({ session: z.number().int(), output: z.string() }),
  readOnly: true,

  run: async ({ session, output }, ctx) => {
    const found = (await listSessions(ctx.sessions)).find((s) => s.number === session);
    if (!found) return `There is no session ${session}.`;

    const dir = path.join(ctx.sessions, found.id);
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"));

    // Matched against what is there rather than joined to a path, so a name like
    // `../../../etc/passwd` simply fails to match anything.
    const wanted = output.trim().toLowerCase();
    const target = files.find((f) => f.toLowerCase() === wanted || f.toLowerCase() === `${wanted}.md`);
    if (!target) {
      return `Session ${session} has no output "${output}". It has: ${files.sort().join(", ") || "nothing"}.`;
    }

    return cap(await readFile(path.join(dir, target), "utf8"));
  },
};
