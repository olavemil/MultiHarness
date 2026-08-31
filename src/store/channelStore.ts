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

/** What the agent itself last said here, and how many messages have passed since. */
export interface LastContribution {
  text: string;
  at: string;
  /** Messages by anyone else since. 0 means the agent spoke last. */
  messagesSince: number;
}

/**
 * The agent's most recent message in this channel, however far back it is.
 *
 * Deliberately not a `readRecent` slice. An agent that has been quiet for a
 * while is exactly the case this exists for, and its last contribution is
 * usually *outside* the window — so tailing N messages would answer "you have
 * said nothing" precisely when the answer matters most.
 *
 * The whole file is parsed, as `readRecent` already does. Channel history is
 * append-only JSONL and this is a per-session read, not a per-message one.
 */
export async function lastContribution(
  paths: Paths,
  channelId: string,
): Promise<LastContribution | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(channelDir(paths, channelId), HISTORY_FILE), "utf8");
  } catch {
    return undefined;
  }

  const messages = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ChannelMessage);

  const index = messages.findLastIndex((message) => message.fromAgent);
  if (index === -1) return undefined;

  const message = messages[index] as ChannelMessage;
  return {
    text: message.text,
    at: message.at,
    messagesSince: messages.length - 1 - index,
  };
}
