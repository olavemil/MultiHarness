import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolves a model-supplied path inside the agent's sandbox directory, or
 * refuses it.
 *
 * **A path validator, not a sandbox.** Nothing here stops a determined process
 * from touching the filesystem; what it stops is a *model* writing outside
 * `files/` because it was asked to, or because a fetched page told it to. The
 * paths arrive from generated text, so they are untrusted in exactly the way
 * fetched URLs are.
 *
 * Three escapes are handled, and the third is the one string checks miss:
 *
 * - **Absolute paths** — refused outright rather than joined, since
 *   `path.join(root, "/etc/passwd")` quietly yields a path inside root but
 *   `path.resolve` does not.
 * - **`..` traversal** — caught by resolving and then checking containment,
 *   rather than by looking for ".." in the text, which misses encodings and
 *   nested forms.
 * - **Symlinks out of the tree** — caught by resolving the *real* path of the
 *   nearest existing ancestor. A link inside `files/` pointing at `/` would
 *   otherwise pass every textual check.
 */

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** Everything the sandbox refuses, with the reason the model gets told. */
export async function resolveSandboxPath(root: string, candidate: string): Promise<string> {
  const raw = candidate.trim();
  if (raw === "") throw new UnsafePathError("an empty path is not a file");
  if (raw.includes("\0")) throw new UnsafePathError("a path may not contain a null byte");

  if (path.isAbsolute(raw)) {
    throw new UnsafePathError(`"${raw}" is an absolute path; give one relative to the files area`);
  }

  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, raw);
  if (!contains(realRoot, target)) {
    throw new UnsafePathError(`"${raw}" resolves outside the files area`);
  }

  // The target may not exist yet — that is the ordinary case for a write — so
  // walk up to the nearest ancestor that does and check where *it* really is.
  // This is what catches a symlink planted inside the sandbox.
  let probe = target;
  for (;;) {
    const parent = path.dirname(probe);
    try {
      const real = await realpath(probe);
      if (!contains(realRoot, real) && real !== realRoot) {
        throw new UnsafePathError(`"${raw}" leads outside the files area through a link`);
      }
      break;
    } catch (cause) {
      if (cause instanceof UnsafePathError) throw cause;
      if (parent === probe) break;
      probe = parent;
    }
  }

  return target;
}

/** True when `target` is `root` itself or sits beneath it. */
function contains(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
