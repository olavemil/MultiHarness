import type { DatabaseSync } from "node:sqlite";
import { readContents, type ContentBlock, type Entry, type Provenance } from "./store.ts";

/**
 * Knowledge compaction: the dedup and normalisation pass the store was designed
 * for and never had. Entries accumulate one append at a time and nothing ever
 * merges them, so a topic written to five times reads as five disconnected
 * remarks.
 *
 * **Deliberately narrow.** Within one entry only — never across entries, because
 * topic and namespace are the immutable key and merging two entries would mean
 * choosing which key survives. Two subjects that share vocabulary are not
 * automatically one subject, which is the same reason the gatekeeper's suite
 * asserts no such merge.
 *
 * **Nothing is deleted.** A compaction appends one new block and marks the
 * blocks it was built from as superseded by it. Readers see the compacted text;
 * `readAllContents` still returns the originals, so a summary can be checked
 * against its evidence. Append-only survives, which is the property that made
 * compaction an open question in the roadmap rather than an obvious feature.
 */

/** The threshold: three separate writes before an entry is worth compacting. */
export const MIN_BLOCKS = 3;

/**
 * Provenance step recorded on a compaction's own block, so it can be told apart
 * from the notes it merged. Owned here rather than passed in by the caller: the
 * candidate query depends on it, and the two disagreeing would silently change
 * the threshold.
 */
export const COMPACT_STEP = "compact";

export interface Candidate {
  entry: Entry;
  blocks: ContentBlock[];
}

/**
 * Entries with enough fresh notes to be worth merging, most-appended first.
 *
 * **Counts notes, not blocks.** A previous compaction's own block is excluded
 * from the tally, so "three separate writes" keeps meaning three *writes* after
 * an entry has been compacted once. Counting live blocks instead let a compacted
 * entry re-qualify on two new notes, because the earlier compaction made up the
 * third — the threshold quietly halving the second time round.
 *
 * Superseded notes are excluded too, so a compacted entry drops out of the list
 * until fresh ones accumulate. Without that, every idle sweep would re-compact
 * the same entry forever.
 */
export function compactionCandidates(db: DatabaseSync, namespace: string): Candidate[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.namespace, e.topic, e.summary, e.created_at,
              COUNT(*) AS blocks,
              SUM(CASE WHEN c.step <> ? THEN 1 ELSE 0 END) AS notes
       FROM entries e JOIN contents c ON c.entry_id = e.id
       WHERE e.namespace = ? AND c.superseded_by IS NULL
       GROUP BY e.id HAVING notes >= ?
       ORDER BY notes DESC, e.topic`,
    )
    .all(COMPACT_STEP, namespace, MIN_BLOCKS) as Record<string, unknown>[];

  return rows.map((row) => {
    const entry: Entry = {
      id: Number(row["id"]),
      namespace: String(row["namespace"]),
      topic: String(row["topic"]),
      summary: String(row["summary"]),
      createdAt: String(row["created_at"]),
    };
    return { entry, blocks: readContents(db, entry.id) };
  });
}

/**
 * Writes the compacted block and supersedes what it was built from.
 *
 * Refuses an empty compaction outright. Superseding several blocks with nothing
 * is the one outcome that genuinely loses the entry — everything else is
 * recoverable by reading the originals.
 *
 * Both writes happen in one transaction: blocks marked superseded by a block
 * that does not exist would leave the entry reading as empty.
 */
export function applyCompaction(
  db: DatabaseSync,
  entryId: number,
  compacted: string,
  provenance: Provenance,
): boolean {
  const text = compacted.trim();
  if (text === "") return false;

  db.exec("BEGIN");
  try {
    const live = db
      .prepare(`SELECT id FROM contents WHERE entry_id = ? AND superseded_by IS NULL`)
      .all(entryId) as { id: number }[];

    const inserted = db
      .prepare(
        `INSERT INTO contents (entry_id, text, session, step, at, superseded_by)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(entryId, text, provenance.session, provenance.step, new Date().toISOString());

    const newId = Number(inserted.lastInsertRowid);
    const mark = db.prepare(`UPDATE contents SET superseded_by = ? WHERE id = ?`);
    for (const row of live) mark.run(newId, row.id);

    db.exec("COMMIT");
    return true;
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}
