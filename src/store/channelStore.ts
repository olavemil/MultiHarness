import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChannelMessage } from "../core/types.ts";
import type { Paths } from "./paths.ts";
import { slug } from "./slug.ts";

/**
 * Channel history as append-only JSONL: trivially inspectable, and adequate
 * indefinitely for "read the last N messages". Only the knowledge store needs
 * a database.
 */

const HISTORY_FILE = "history.jsonl";

function channelDir(paths: Paths, channelId: string): string {
  return path.join(paths.channels, slug(channelId));
}

export async function appendMessage(
  paths: Paths,
  channelId: string,
  message: ChannelMessage,
): Promise<void> {
  const dir = channelDir(paths, channelId);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, HISTORY_FILE), `${JSON.stringify(message)}\n`, "utf8");
}

/** The most recent `limit` messages, oldest first. */
export async function readRecent(
  paths: Paths,
  channelId: string,
  limit: number,
): Promise<ChannelMessage[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(channelDir(paths, channelId), HISTORY_FILE), "utf8");
  } catch {
    return [];
  }

  const messages = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ChannelMessage);

  return messages.slice(-limit);
}
