import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Identity } from "../core/types.ts";
import type { Paths } from "./paths.ts";
import { slug } from "./slug.ts";

/**
 * Identities are first-class: the agent tracks who it is talking to without
 * needing to know whether they are human.
 *
 * Records are created on first contact with a bare skeleton. Populating the
 * summary is `reflect`'s job, and generating a description with the `fast`
 * model belongs to the knowledge gatekeeper — neither exists yet.
 */

function identityFile(paths: Paths, identityId: string): string {
  return path.join(paths.identities, `${slug(identityId)}.json`);
}

export async function loadIdentity(
  paths: Paths,
  identityId: string,
  displayName = identityId,
): Promise<Identity> {
  try {
    const raw = await readFile(identityFile(paths, identityId), "utf8");
    return JSON.parse(raw) as Identity;
  } catch {
    const created: Identity = { id: identityId, displayName, aliases: [], summary: "" };
    await saveIdentity(paths, created);
    return created;
  }
}

export async function saveIdentity(paths: Paths, identity: Identity): Promise<void> {
  await mkdir(paths.identities, { recursive: true });
  await writeFile(
    identityFile(paths, identity.id),
    `${JSON.stringify(identity, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Every identity on file. Used only by the step deciding whether to message
 * somebody unprompted; the reply path always knows exactly whose message it is
 * holding.
 */
export async function listIdentities(paths: Paths): Promise<Identity[]> {
  let files: string[];
  try {
    files = await readdir(paths.identities);
  } catch {
    return [];
  }

  const found: Identity[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(paths.identities, file), "utf8");
      found.push(JSON.parse(raw) as Identity);
    } catch {
      // One unreadable record must not hide every other person on file.
    }
  }
  return found;
}
