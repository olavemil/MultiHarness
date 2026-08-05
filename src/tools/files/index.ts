import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { resolveSandboxPath, UnsafePathError } from "./safePath.ts";

/**
 * The agent's own filesystem, under `files/` in the working directory.
 *
 * These are what let a plan name something concrete to produce. Without them a
 * plan that lists files is unsatisfiable, and an unsatisfiable plan is exactly
 * the "nothing can close it" failure the plan store is built to avoid.
 *
 * Every path goes through `resolveSandboxPath`. A path that fails comes back as
 * a tool *result* rather than an exception, like every other tool failure — the
 * model reaching outside the sandbox must not kill the step, it must be told no
 * and given the chance to correct.
 */

const CAP = 4_000;
const cap = (text: string): string =>
  text.length <= CAP ? text : `${text.slice(0, CAP)}\n[… truncated]`;

/** Turns a refusal into text the model can act on. */
const refuse = (cause: unknown): string =>
  cause instanceof UnsafePathError
    ? `Refused: ${cause.message}.`
    : `Failed: ${cause instanceof Error ? cause.message : String(cause)}`;

export const fileList: ToolDefinition<{ directory?: string | undefined }> = {
  name: "file_list",
  description:
    "List the agent's own files, with their sizes. Give a directory to look inside one, " +
    "or omit it for everything. Use this before reading or writing to see what exists.",
  parameters: z.object({ directory: z.string().optional() }),
  readOnly: true,

  run: async ({ directory }, ctx) => {
    try {
      const root = await resolveSandboxPath(ctx.files, directory?.trim() || ".");
      const entries = await walk(root, ctx.files);
      if (entries.length === 0) return "The agent has no files yet.";
      return cap(entries.map((e) => `- ${e.path} (${e.size} bytes)`).join("\n"));
    } catch (cause) {
      return refuse(cause);
    }
  },
};

export const fileRead: ToolDefinition<{ path: string }> = {
  name: "file_read",
  description: "Read one of the agent's own files, by path relative to its files area.",
  parameters: z.object({ path: z.string() }),
  readOnly: true,

  run: async ({ path: target }, ctx) => {
    try {
      const resolved = await resolveSandboxPath(ctx.files, target);
      return cap(await readFile(resolved, "utf8"));
    } catch (cause) {
      return refuse(cause);
    }
  },
};

export const fileWrite: ToolDefinition<{ path: string; content: string }> = {
  name: "file_write",
  description:
    "Write one of the agent's own files, creating or replacing it. Parent directories are " +
    "created as needed. This is how work that should outlive the session gets recorded.",
  parameters: z.object({ path: z.string(), content: z.string() }),
  readOnly: false,

  run: async ({ path: target, content }, ctx) => {
    try {
      const resolved = await resolveSandboxPath(ctx.files, target);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
      const rel = path.relative(await resolveSandboxPath(ctx.files, "."), resolved);
      return `Wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes).`;
    } catch (cause) {
      return refuse(cause);
    }
  },
};

/** Files beneath `dir`, reported relative to the sandbox root. */
async function walk(dir: string, root: string): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const realRoot = await resolveSandboxPath(root, ".");

  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Re-validated on the way down: a symlink inside the tree is exactly the
      // case a single check at the top would miss.
      let safe: string;
      try {
        safe = await resolveSandboxPath(root, path.relative(realRoot, full));
      } catch {
        continue;
      }
      if (entry.isDirectory()) await visit(safe);
      else if (entry.isFile()) {
        out.push({ path: path.relative(realRoot, safe), size: (await stat(safe)).size });
      }
    }
  };

  await visit(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
