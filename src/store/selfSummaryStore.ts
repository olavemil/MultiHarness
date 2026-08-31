import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Paths } from "./paths.ts";
import { readRecent } from "./channelStore.ts";
import { loadPriorSession } from "./priorSession.ts";
import { surveyChannels } from "./channelRegistry.ts";

const DIR = "self";
const POINTER = "self_summary.json";

const selfDir = (paths: Paths): string => path.join(paths.root, DIR);

export interface SelfSummary {
  text: string;
  revision: number;
  session: string;
  at: string;
}

export async function loadSelfSummary(paths: Paths): Promise<SelfSummary | undefined> {
  try {
    const raw = await readFile(path.join(selfDir(paths), POINTER), "utf8");
    const pointer = JSON.parse(raw) as { revision: number; session: string; at: string };
    const text = await readFile(path.join(selfDir(paths), `self_summary_${pointer.revision}.md`), "utf8");
    return { text: text.trim(), revision: pointer.revision, session: pointer.session, at: pointer.at };
  } catch {
    return undefined;
  }
}

export async function writeSelfSummary(
  paths: Paths,
  text: string,
  session: string,
): Promise<SelfSummary> {
  const body = text.trim();
  if (body === "") {
    const existing = await loadSelfSummary(paths);
    if (existing) return existing;
  }

  const dir = selfDir(paths);
  await mkdir(dir, { recursive: true });
  const previous = await loadSelfSummary(paths);
  const revision = previous ? previous.revision + 1 : 0;
  const at = new Date().toISOString();

  const file = path.join(dir, `self_summary_${revision}.md`);
  await writeFile(file, `${body}\n`, "utf8");
  await chmod(file, 0o444);
  await writeFile(path.join(dir, POINTER), JSON.stringify({ revision, session, at }), "utf8");

  return { text: body, revision, session, at };
}

/**
 * Cross-channel evidence for the fast self-summary step, newest-first.
 *
 * The model should summarise this into a concise persistent view rather than
 * passing full markdown artifacts downstream.
 */
export async function buildSelfSummaryEvidence(
  paths: Paths,
  agentName: string,
): Promise<string> {
  const channels = (await surveyChannels(paths, agentName, 200))
    .sort((a, b) => a.silentMs - b.silentMs)
    .slice(0, 12);
  if (channels.length === 0) return "No channel history is available yet.";

  const recentMessages: { at: string; line: string }[] = [];
  const recentReviews: { session: number; line: string }[] = [];

  for (const channel of channels) {
    const messages = await readRecent(paths, channel.id, 6);
    for (const m of messages) {
      recentMessages.push({
        at: m.at,
        line: `${m.at} | ${channel.name} | ${m.author}: ${compact(m.text, 160)}`,
      });
    }

    const prior = await loadPriorSession(paths, channel.id);
    if (!prior || prior.review.trim() === "") continue;
    const point = firstPoint(prior.review);
    recentReviews.push({
      session: prior.number,
      line: `${prior.id} | ${channel.name} | ${point}`,
    });
  }

  recentMessages.sort((a, b) => b.at.localeCompare(a.at));
  recentReviews.sort((a, b) => b.session - a.session);

  const lines: string[] = [];

  lines.push("LATEST_MESSAGES");
  for (const item of recentMessages.slice(0, 32)) lines.push(`- ${item.line}`);

  lines.push("----------");
  lines.push("LATEST_REVIEWS");
  if (recentReviews.length === 0) {
    lines.push("- (no review artifacts found yet)");
  } else {
    for (const item of recentReviews.slice(0, 16)) lines.push(`- ${item.line}`);
  }

  lines.push("----------");
  lines.push("CHANNEL_ACTIVITY");
  for (const channel of channels) {
    const silentMinutes = Math.floor(channel.silentMs / 60000);
    const status = channel.agentHasSpoken
      ? `${channel.messagesSinceAgentSpoke} since agent last spoke`
      : "agent has not spoken there";
    lines.push(
      `- ${channel.name} | quiet ${silentMinutes}m | ${channel.messages} msgs seen | ${status}`,
    );
  }

  return lines.join("\n");
}

function firstPoint(markdown: string): string {
  const line = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#") && l !== "```" && !l.startsWith("|"));
  return compact(line ?? "(no concise point found)", 220);
}

function compact(text: string, max: number): string {
  const cleaned = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

export async function loadSelfSummaryHistory(paths: Paths): Promise<string[]> {
  try {
    const files = (await readdir(selfDir(paths)))
      .filter((f) => /^self_summary_\d+\.md$/.test(f))
      .sort((a, b) => revisionOf(a) - revisionOf(b));
    return Promise.all(files.map((f) => readFile(path.join(selfDir(paths), f), "utf8")));
  } catch {
    return [];
  }
}

const revisionOf = (file: string): number => Number(file.match(/(\d+)/)?.[1] ?? 0);
