import { createHash } from "node:crypto";

const UNSAFE = /[^a-zA-Z0-9._-]/g;

/**
 * Filesystem-safe name for an arbitrary channel or identity id.
 *
 * A short hash is appended whenever characters were replaced, so two ids that
 * differ only in stripped characters cannot collide onto one directory.
 */
export function slug(id: string): string {
  const cleaned = id.replace(UNSAFE, "_").slice(0, 64);
  if (cleaned === id) return cleaned;

  const digest = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return `${cleaned}-${digest}`;
}
