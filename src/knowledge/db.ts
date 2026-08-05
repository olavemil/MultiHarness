import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The knowledge store: one sqlite file, no dependencies beyond Node's built-in
 * driver.
 *
 * FTS5 ships with sqlite, and the gatekeeper's nearest-topic prefilter runs as
 * cosine similarity in JS rather than through `sqlite-vec` — a few thousand
 * 1024-dimension dot products cost microseconds, which is not worth a loadable
 * extension and the packaging that comes with it.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Topic and namespace are the immutable key. There is deliberately no UPDATE
-- path for them: the primary key of a knowledge entry never moves.
CREATE TABLE IF NOT EXISTS entries (
  id             INTEGER PRIMARY KEY,
  namespace      TEXT NOT NULL,
  topic          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  created_session TEXT NOT NULL,
  embedding      BLOB,
  UNIQUE (namespace, topic)
);

-- Content is append-only with provenance. A replace would destroy the evidence
-- of how an entry came to say what it says.
--
-- superseded_by points at the compacted block that replaced this one for
-- reading. The row itself is never deleted or edited: compaction produces a new
-- revision and marks what it was built from, so the evidence behind a summary
-- survives the summarising. A store that discarded the originals could never be
-- checked against them.
CREATE TABLE IF NOT EXISTS contents (
  id       INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  session  TEXT NOT NULL,
  step     TEXT NOT NULL,
  at       TEXT NOT NULL,
  superseded_by INTEGER REFERENCES contents(id)
);
CREATE INDEX IF NOT EXISTS contents_entry ON contents (entry_id);
CREATE INDEX IF NOT EXISTS contents_live ON contents (entry_id, superseded_by);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(topic, summary, body);

-- Reject rate is the calibration signal for the gatekeeper prompt, so a
-- rejection is data rather than a silent drop.
CREATE TABLE IF NOT EXISTS rejections (
  id        INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL,
  candidate TEXT NOT NULL,
  verdict   TEXT NOT NULL,
  reason    TEXT NOT NULL,
  session   TEXT NOT NULL,
  step      TEXT NOT NULL,
  at        TEXT NOT NULL
);
`;

/** Knowledge and identity entries never share a namespace. */
export const KNOWLEDGE = "knowledge";
export const IDENTITY = "identity";

/**
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a column added
 * after a store was created has to be added explicitly. Checked rather than
 * try/caught, because a swallowed exception here would hide a real schema error
 * and only surface as a query failing much later.
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(contents)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "superseded_by")) {
    db.exec(`ALTER TABLE contents ADD COLUMN superseded_by INTEGER REFERENCES contents(id)`);
  }
}

export function openKnowledgeDb(knowledgeDir: string): DatabaseSync {
  mkdirSync(knowledgeDir, { recursive: true });
  const db = new DatabaseSync(path.join(knowledgeDir, "knowledge.sqlite"));
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** In-memory database, for tests. */
export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}
