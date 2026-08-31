import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";
import { readRecent } from "./channelStore.ts";
import { slug } from "./slug.ts";

/**
 * Every conversation the agent is part of, and how quiet each has gone.
 *
 * **The daemon already tracked most of this and could not use it.** Its
 * in-memory `channels` map holds last activity, but only for channels that have
 * seen traffic since the process started — so an agent deciding whether to say
 * something unprompted would see a room it talked in yesterday as one it has
 * never heard of. A survey of conversations has to survive a restart or it is a
 * survey of the last few minutes.
 *
 * The name is stored because an id is not something to say out loud. `C07ABCXYZ`
 * is what Slack calls a channel and `#deploys` is what the people in it call it,
 * and a step reasoning about where to speak needs the second.
 */

const RECORD = "channel.json";

const channelDir = (paths: Paths, channelId: string): string =>
  path.join(paths.channels, slug(channelId));

export interface ChannelRecord {
  id: string;
  /** What the people in it call it. Falls back to the id. */
  name: string;
  /** ISO time of the most recent message from anybody. */
  lastActivity?: string;
}

/** How a channel looks to a step deciding whether to speak into it. */
export interface ChannelSurvey extends ChannelRecord {
  /** Milliseconds since anybody said anything. */
  silentMs: number;
  /** Messages since the agent itself last spoke. `total` when it never has. */
  messagesSinceAgentSpoke: number;
  /**
   * How many messages at the *end* of the conversation are the agent's own.
   *
   * The count the graduated gate turns on: one means it had the last word, two
   * means it has already spoken twice unanswered, and a third would be talking
   * to itself in public. `messagesSinceAgentSpoke` cannot answer that — it is 0
   * for both.
   */
  trailingAgentMessages: number;
  /** False when the agent has never said anything here. */
  agentHasSpoken: boolean;
  /** Total messages on record, so "silent for a week" can be told from "empty". */
  messages: number;
}

/**
 * Records the channel and its name. Called on every inbound message, so a
 * rename follows the workspace without a migration.
 */
export async function rememberChannel(
  paths: Paths,
  channelId: string,
  name: string | undefined,
  at: string,
): Promise<void> {
  const dir = channelDir(paths, channelId);
  await mkdir(dir, { recursive: true });
  const existing = await loadChannel(paths, channelId);
  const record: ChannelRecord = {
    id: channelId,
    // An adapter that does not know the name must not overwrite one that was
    // learned earlier — the CLI supplies none, and Slack only on some events.
    name: name?.trim() || existing?.name || channelId,
    lastActivity: at,
  };
  await writeFile(path.join(dir, RECORD), JSON.stringify(record, null, 2), "utf8");
}

export async function loadChannel(
  paths: Paths,
  channelId: string,
): Promise<ChannelRecord | undefined> {
  try {
    const raw = await readFile(path.join(channelDir(paths, channelId), RECORD), "utf8");
    return JSON.parse(raw) as ChannelRecord;
  } catch {
    return undefined;
  }
}

/**
 * Every known channel, quietest first.
 *
 * The counts come from the history on disk rather than from a maintained
 * tally, deliberately: a counter that drifts from the messages it counts is
 * worse than one derived on demand, and this runs once per idle sweep at most.
 */
export async function surveyChannels(
  paths: Paths,
  agentName: string,
  limit = 40,
): Promise<ChannelSurvey[]> {
  let dirs: string[];
  try {
    dirs = await readdir(paths.channels);
  } catch {
    return [];
  }

  const now = Date.now();
  const surveys: ChannelSurvey[] = [];

  for (const dir of dirs) {
    const record = await readRecord(paths, dir);
    if (!record) continue;

    const history = await readRecent(paths, record.id, limit);
    const last = history.at(-1);
    const lastAt = last?.at ?? record.lastActivity;

    // `fromAgent` rather than the author string: history written by an older
    // build labels the agent's own turns `agent` rather than by name, and a
    // survey that missed those would report the agent as never having spoken.
    const lastAgent = history.findLastIndex((m) => m.fromAgent || m.author === agentName);

    let trailing = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      if (!(m.fromAgent || m.author === agentName)) break;
      trailing++;
    }

    surveys.push({
      ...record,
      trailingAgentMessages: trailing,
      silentMs: lastAt ? Math.max(0, now - new Date(lastAt).getTime()) : Number.POSITIVE_INFINITY,
      agentHasSpoken: lastAgent !== -1,
      messagesSinceAgentSpoke: lastAgent === -1 ? history.length : history.length - 1 - lastAgent,
      messages: history.length,
    });
  }

  return surveys.sort((a, b) => b.silentMs - a.silentMs);
}

async function readRecord(paths: Paths, dir: string): Promise<ChannelRecord | undefined> {
  try {
    const raw = await readFile(path.join(paths.channels, dir, RECORD), "utf8");
    return JSON.parse(raw) as ChannelRecord;
  } catch {
    return undefined;
  }
}

/**
 * The last thing one person said, wherever they said it.
 *
 * For a DM the agent is opening there is no shared history to draw on, so the
 * most recent thing they said in *any* channel is the only handle it has on what
 * they were last thinking about — and it is what lets an unprompted message pick
 * up a thread rather than arrive from nowhere.
 */
export async function latestFrom(
  paths: Paths,
  identityId: string,
  limit = 40,
): Promise<{ author: string; text: string; where: string; at: string } | undefined> {
  let dirs: string[];
  try {
    dirs = await readdir(paths.channels);
  } catch {
    return undefined;
  }

  let best: { author: string; text: string; where: string; at: string } | undefined;
  for (const dir of dirs) {
    const record = await readRecord(paths, dir);
    if (!record) continue;
    for (const m of await readRecent(paths, record.id, limit)) {
      if (m.identityId !== identityId) continue;
      if (!best || m.at > best.at) {
        best = { author: m.author, text: m.text, where: record.name, at: m.at };
      }
    }
  }
  return best;
}
