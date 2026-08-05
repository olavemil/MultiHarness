import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileList, fileRead, fileWrite } from "../src/tools/files/index.ts";
import { sessionList, sessionRead } from "../src/tools/sessions.ts";
import { resolveSandboxPath, UnsafePathError } from "../src/tools/files/safePath.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { tempWorkingDir } from "./helpers/fixtures.ts";

/**
 * The agent's sandbox filesystem.
 *
 * Paths arrive from generated text, so they are untrusted in the same way a
 * fetched URL is — a page the agent read can perfectly well contain a filename.
 * These tests are about the boundary rather than the convenience.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sandbox() {
  const { dir, cleanup } = await tempWorkingDir();
  cleanups.push(cleanup);
  const files = path.join(dir, "files");
  await mkdir(files, { recursive: true });
  // Only `files` is read by these tools; the rest of the context is unused.
  const ctx = { files, sessions: path.join(dir, "sessions") } as ToolContext;
  return { dir, files, ctx };
}

describe("resolveSandboxPath", () => {
  it("accepts a plain relative path and a nested one", async () => {
    const { files } = await sandbox();
    await expect(resolveSandboxPath(files, "notes.md")).resolves.toBe(
      path.join(await realish(files), "notes.md"),
    );
    await expect(resolveSandboxPath(files, "a/b/c.txt")).resolves.toContain("a/b/c.txt");
  });

  it("refuses an absolute path rather than joining it", async () => {
    // `path.join(root, "/etc/passwd")` quietly lands inside root; `path.resolve`
    // does not. Refusing outright avoids depending on which one is used.
    const { files } = await sandbox();
    await expect(resolveSandboxPath(files, "/etc/passwd")).rejects.toThrowError(UnsafePathError);
  });

  it("refuses traversal, however it is spelled", async () => {
    const { files } = await sandbox();
    for (const attempt of ["../secrets", "a/../../secrets", "./a/b/../../../x"]) {
      await expect(resolveSandboxPath(files, attempt)).rejects.toThrowError(/outside the files/);
    }
  });

  it("refuses a symlink that leads out of the tree", async () => {
    // The escape a textual check misses entirely: nothing in "escape/passwd"
    // looks suspicious.
    const { dir, files } = await sandbox();
    const outside = path.join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "passwd"), "secret", "utf8");
    await symlink(outside, path.join(files, "escape"));

    await expect(resolveSandboxPath(files, "escape/passwd")).rejects.toThrowError(/through a link/);
  });

  it("refuses empty and null-byte paths", async () => {
    const { files } = await sandbox();
    await expect(resolveSandboxPath(files, "   ")).rejects.toThrowError(UnsafePathError);
    await expect(resolveSandboxPath(files, "a\0b")).rejects.toThrowError(UnsafePathError);
  });

  it("allows a path whose parent does not exist yet", async () => {
    // The ordinary case for a write. Validation has to walk up to something
    // real rather than requiring the target to exist.
    const { files } = await sandbox();
    await expect(resolveSandboxPath(files, "reports/2026/q1.md")).resolves.toContain("q1.md");
  });
});

describe("the file tools", () => {
  it("writes, lists, and reads back", async () => {
    const { files, ctx } = await sandbox();

    expect(await fileWrite.run({ path: "notes/plan.md", content: "hello" }, ctx)).toContain(
      "Wrote notes/plan.md",
    );
    expect(await readFile(path.join(files, "notes/plan.md"), "utf8")).toBe("hello");

    expect(await fileList.run({}, ctx)).toContain("notes/plan.md (5 bytes)");
    expect(await fileRead.run({ path: "notes/plan.md" }, ctx)).toBe("hello");
  });

  it("says so plainly when there are no files", async () => {
    const { ctx } = await sandbox();
    expect(await fileList.run({}, ctx)).toBe("The agent has no files yet.");
  });

  it("returns a refusal as a result, never as an exception", async () => {
    // A model reaching outside the sandbox must not kill the step. It gets told
    // no and can correct — the same contract as every other tool failure.
    const { ctx } = await sandbox();

    await expect(fileWrite.run({ path: "../escape.txt", content: "x" }, ctx)).resolves.toMatch(
      /^Refused:/,
    );
    await expect(fileRead.run({ path: "/etc/passwd" }, ctx)).resolves.toMatch(/^Refused:/);
  });

  it("reports a missing file as a failure rather than throwing", async () => {
    const { ctx } = await sandbox();
    await expect(fileRead.run({ path: "nope.md" }, ctx)).resolves.toMatch(/^Failed:/);
  });

  it("marks the write tool as such, so `no_tools` roles are refused it", async () => {
    expect(fileWrite.readOnly).toBe(false);
    expect(fileRead.readOnly).toBe(true);
    expect(fileList.readOnly).toBe(true);
  });
});

describe("the session reader", () => {
  async function withSessions() {
    const { dir, ctx } = await sandbox();
    const sessions = path.join(dir, "sessions");
    await mkdir(path.join(sessions, "000007-2026-08-04T21-11-58Z"), { recursive: true });
    await mkdir(path.join(sessions, "000012-2026-08-05T09-00-00Z"), { recursive: true });
    await writeFile(
      path.join(sessions, "000007-2026-08-04T21-11-58Z", "response.md"),
      "Node 22 or newer.",
      "utf8",
    );
    await writeFile(
      path.join(sessions, "000012-2026-08-05T09-00-00Z", "thoughts.md"),
      "sqlite wins on search.",
      "utf8",
    );
    return { ctx, sessions };
  }

  it("lists sessions newest first, with what each sealed", async () => {
    const { ctx } = await withSessions();
    const listed = await sessionList.run({}, ctx);
    expect(listed.indexOf("12:")).toBeLessThan(listed.indexOf("7:"));
    expect(listed).toContain("response.md");
  });

  it("reads a sealed output by session number", async () => {
    const { ctx } = await withSessions();
    expect(await sessionRead.run({ session: 7, output: "response.md" }, ctx)).toBe(
      "Node 22 or newer.",
    );
    // The extension is optional, since a model will drop it as often as not.
    expect(await sessionRead.run({ session: 12, output: "thoughts" }, ctx)).toContain("sqlite");
  });

  it("names what a session does have when the output is wrong", async () => {
    const { ctx } = await withSessions();
    const answer = await sessionRead.run({ session: 7, output: "draft.md" }, ctx);
    expect(answer).toContain("no output");
    expect(answer).toContain("response.md");
  });

  it("cannot be walked out of, because nothing is joined to a path", async () => {
    // The name is matched against the directory listing rather than appended to
    // it, so traversal has nothing to traverse.
    const { ctx } = await withSessions();
    const answer = await sessionRead.run({ session: 7, output: "../../../etc/passwd" }, ctx);
    expect(answer).toContain("no output");
    expect(answer).not.toContain("root:");
  });

  it("says so plainly for a session that does not exist", async () => {
    const { ctx } = await withSessions();
    expect(await sessionRead.run({ session: 999, output: "response.md" }, ctx)).toBe(
      "There is no session 999.",
    );
  });

  it("reports an empty history rather than failing", async () => {
    const { ctx } = await sandbox();
    expect(await sessionList.run({}, ctx)).toBe("There are no earlier sessions.");
  });
});

/** macOS puts temp dirs behind a symlink, so compare against the resolved root. */
async function realish(dir: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(dir);
}
