import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config/schema.ts";
import { CURIOSITY } from "./db.ts";
import { embedText, nearest } from "./similarity.ts";
import { appendContent, createEntry, readContents, type Provenance } from "./store.ts";

/**
 * What the agent noticed it does not know, and has not yet closed.
 *
 * **The gap this fills is the reason the agent had no drive at all.** Every
 * session already produces the raw material: `research` reports `gaps` —
 * "anything you could not establish that would have changed the answer" —
 * `reason` reports `uncertainties`, and `debrief` reports what a session was
 * asked and never answered. All three were sealed into step output, read by
 * `respond` in the same session, and never seen again. The agent noticed what it
 * did not know, said so plainly, and forgot within seconds. Nothing could
 * accumulate, so nothing could ever motivate anything.
 *
 * These are the third cross-channel loop, after knowledge and impressions, and
 * they inherit the same warning: **a mistake in a cross-channel loop does not
 * expire.** Hence append-only, an explicit close, and a prune step whose whole
 * job is dropping things.
 *
 * Stored in the knowledge database under its own namespace. That reuses
 * append-only content with provenance, and — the part that matters — the
 * embedding prefilter, which turns "this gap has come up before" into a fact the
 * harness can establish rather than a judgement it has to ask for. Recurrence is
 * then simply the number of blocks under an entry.
 */

export interface Curiosity {
  id: number;
  /** The open question itself, verbatim as the step phrased it. Immutable. */
  question: string;
  /** Which channel it first came up in — a plan is per-channel. */
  channelId: string;
  /** How many times it has been recorded. One means it has come up once. */
  resurfaced: number;
  /** How many times an idle session has gone and worked on it. */
  pursued: number;
  createdAt: string;
}

/**
 * Provenance on a block the *harness* wrote, rather than one a step reported.
 *
 * **Load-bearing, and it was nearly a real bug.** Recurrence is the block count,
 * and recording a pursuit appends a block — so pursuing a question would have
 * made it look more pressing, and an idle agent would have researched the same
 * thing every quiet period, each pass making the next one likelier. Exactly the
 * shape that halved `compact`'s threshold on every pass after the first, and
 * fixed the same way: the tally excludes blocks by their provenance step.
 */
export const PURSUIT_STEP = "harness";

interface EntryRow {
  id: number;
  topic: string;
  origin_channel: string | null;
  created_at: string;
}

/**
 * Records an open question, merging it into an existing one when it is the same
 * question asked differently.
 *
 * **Merging is what makes recurrence countable.** "What version the vendor
 * ships" and "which release the vendor is on" are one open question and two
 * phrasings; kept apart they are two curiosities that never look pressing, and
 * merged they are one that has now come up twice. The threshold is the same kind
 * of measured guess as `[session.standing] threshold`, and shares its hazard:
 * absolute cosine on short strings clusters far below 1, so the usable band is
 * specific to the embedding model.
 *
 * Silent on failure by design. Harvesting runs at the tail of a session that has
 * already done its work; an unreachable embedding model must not fail it.
 */
export async function recordCuriosity(
  db: DatabaseSync,
  config: Config,
  question: string,
  channelId: string,
  provenance: Provenance,
): Promise<Curiosity | undefined> {
  const text = question.trim();
  if (text === "") return undefined;

  let vector: number[] | undefined;
  try {
    vector = await embedText(config, text);
  } catch {
    // No embedding means no merge check. Recording it anyway would create a
    // duplicate of something already open, and duplicates are what the
    // threshold exists to prevent, so this one is dropped.
    return undefined;
  }

  const [closest] = nearest(db, CURIOSITY, vector, 1);
  if (closest && closest.score >= config.session.curiosity.merge_threshold) {
    const row = db
      .prepare(`SELECT id, topic, origin_channel, created_at FROM entries WHERE id = ?`)
      .get(closest.entry.id) as unknown as EntryRow | undefined;
    if (row && !isClosed(db, row.id)) {
      appendContent(db, row.id, text, provenance);
      return toCuriosity(db, row);
    }
  }

  // `topic` is the immutable key, so a question that differs only in wording
  // from a *closed* one gets a new entry rather than reopening the old. That is
  // deliberate: reopening would undo a deliberate close, which is the one thing
  // a store with no delete path cannot recover from.
  const entry = createEntry(db, CURIOSITY, uniqueTopic(db, text), text, vector, provenance);
  db.prepare(`UPDATE entries SET origin_channel = ? WHERE id = ?`).run(channelId, entry.id);
  appendContent(db, entry.id, text, provenance);
  return {
    id: entry.id,
    question: text,
    channelId,
    resurfaced: 1,
    pursued: 0,
    createdAt: entry.createdAt,
  };
}

/** Open curiosities, most-resurfaced first, then oldest. */
export function openCuriosities(db: DatabaseSync): Curiosity[] {
  const rows = db
    .prepare(
      `SELECT id, topic, origin_channel, created_at FROM entries
       WHERE namespace = ? AND closed_at IS NULL ORDER BY created_at`,
    )
    .all(CURIOSITY) as unknown as EntryRow[];

  return rows
    .map((row) => toCuriosity(db, row))
    .sort((a, b) => b.resurfaced - a.resurfaced || a.createdAt.localeCompare(b.createdAt));
}

/**
 * Closes one. `reason` is kept rather than discarded, so a curiosity that turns
 * out to have been dropped in error can be read back.
 *
 * Never deletes: the entry and every block it accumulated stay on disk, exactly
 * as a compaction supersedes rather than replaces. Closing is not forgetting.
 */
export function closeCuriosity(db: DatabaseSync, id: number, reason: string): void {
  db.prepare(`UPDATE entries SET closed_at = ?, closed_reason = ? WHERE id = ? AND namespace = ?`)
    .run(new Date().toISOString(), reason, id, CURIOSITY);
}

/**
 * Records that an idle session went and worked on one, so a later `prune` can
 * see it was tried.
 *
 * Written under `PURSUIT_STEP` whatever the caller passes, because the tally
 * depends on it and a caller that got the step name wrong would silently inflate
 * the recurrence count it is meant to be excluded from.
 */
export function recordPursuit(db: DatabaseSync, id: number, note: string, session: string): void {
  const provenance: Provenance = { session, step: PURSUIT_STEP };
  appendContent(db, id, note, provenance);
}

function isClosed(db: DatabaseSync, id: number): boolean {
  const row = db.prepare(`SELECT closed_at FROM entries WHERE id = ?`).get(id) as
    | { closed_at: string | null }
    | undefined;
  return row?.closed_at != null;
}

function toCuriosity(db: DatabaseSync, row: EntryRow): Curiosity {
  const blocks = readContents(db, row.id);
  return {
    id: row.id,
    question: row.topic,
    channelId: row.origin_channel ?? "",
    resurfaced: blocks.filter((b) => b.step !== PURSUIT_STEP).length,
    pursued: blocks.filter((b) => b.step === PURSUIT_STEP).length,
    createdAt: row.created_at,
  };
}

/**
 * `(namespace, topic)` is unique and the question itself is the topic, so two
 * genuinely identical strings would collide. Suffixed rather than merged,
 * because reaching here means the embedding said they were *not* the same
 * question — and the constraint should not quietly overrule the measurement.
 */
function uniqueTopic(db: DatabaseSync, text: string): string {
  const taken = (topic: string): boolean =>
    db.prepare(`SELECT 1 FROM entries WHERE namespace = ? AND topic = ?`).get(CURIOSITY, topic) !==
    undefined;

  if (!taken(text)) return text;
  for (let n = 2; n < 100; n++) {
    const candidate = `${text} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  return `${text} (${Date.now()})`;
}
