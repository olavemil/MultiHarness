import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";
import { slug } from "./slug.ts";
import type { SessionHandle } from "./sessionStore.ts";

/**
 * Per-channel pointer to the last completed session, and its readable output.
 *
 * Sessions are numbered globally but reflection is per channel: what matters to
 * `reflect` is "how did the last exchange *here* go", not whatever session
 * happened to run most recently somewhere else.
 */

export interface PriorSession {
  id: string;
  number: number;
  /** Sealed output of the previous session in this channel. Empty when absent. */
  review: string;
  summary: string;
  reflection: string;
}

const POINTER = "last_session.json";

const pointerPath = (paths: Paths, channelId: string): string =>
  path.join(paths.channels, slug(channelId), POINTER);

export async function recordLastSession(
  paths: Paths,
  channelId: string,
  session: SessionHandle,
): Promise<void> {
  // A session can be the first thing that ever touches a channel, so the
  // directory is not guaranteed to exist yet.
  await mkdir(path.join(paths.channels, slug(channelId)), { recursive: true });
  await writeFile(
    pointerPath(paths, channelId),
    `${JSON.stringify({ id: session.id, number: session.number, dir: session.dir }, null, 2)}\n`,
    "utf8",
  );
}

/** Absent on the first session in a channel, which is why `reflect` is skipped then. */
export async function loadPriorSession(
  paths: Paths,
  channelId: string,
): Promise<PriorSession | undefined> {
  let pointer: { id: string; number: number; dir: string };
  try {
    pointer = JSON.parse(await readFile(pointerPath(paths, channelId), "utf8"));
  } catch {
    return undefined;
  }

  const [review, summary, reflection] = await Promise.all(
    ["review.md", "summary.md", "reflection.md"].map((file) => readIfPresent(pointer.dir, file)),
  );

  return {
    id: pointer.id,
    number: pointer.number,
    review: review ?? "",
    summary: summary ?? "",
    reflection: reflection ?? "",
  };
}

async function readIfPresent(dir: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, file), "utf8");
  } catch {
    return undefined;
  }
}
