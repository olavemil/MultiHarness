import type { DatabaseSync } from "node:sqlite";

/**
 * Entry and content operations. Nothing here decides *whether* a write should
 * happen — that is the gatekeeper's job, and no step calls these directly.
 */

export interface Entry {
  id: number;
  namespace: string;
  topic: string;
  summary: string;
  createdAt: string;
}

export interface ContentBlock {
  text: string;
  session: string;
  step: string;
  at: string;
}

export interface Provenance {
  session: string;
  step: string;
}

export const toBlob = (vector: readonly number[]): Uint8Array =>
  new Uint8Array(Float32Array.from(vector).buffer);

export const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

export function createEntry(
  db: DatabaseSync,
  namespace: string,
  topic: string,
  summary: string,
  embedding: readonly number[] | undefined,
  provenance: Provenance,
): Entry {
  const at = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO entries (namespace, topic, summary, created_at, created_session, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      namespace,
      topic,
      summary,
      at,
      provenance.session,
      embedding ? toBlob(embedding) : null,
    );

  const id = Number(result.lastInsertRowid);
  reindex(db, id, topic, summary, "");
  return { id, namespace, topic, summary, createdAt: at };
}

/** Appends to an existing entry. Never rewrites what is already there. */
export function appendContent(
  db: DatabaseSync,
  entryId: number,
  text: string,
  provenance: Provenance,
): void {
  db.prepare(
    `INSERT INTO contents (entry_id, text, session, step, at) VALUES (?, ?, ?, ?, ?)`,
  ).run(entryId, text, provenance.session, provenance.step, new Date().toISOString());

  const entry = db
    .prepare(`SELECT topic, summary FROM entries WHERE id = ?`)
    .get(entryId) as { topic: string; summary: string } | undefined;
  if (entry) reindex(db, entryId, entry.topic, entry.summary, readBody(db, entryId));
}

export function findEntry(
  db: DatabaseSync,
  namespace: string,
  topic: string,
): Entry | undefined {
  const row = db
    .prepare(
      `SELECT id, namespace, topic, summary, created_at FROM entries
       WHERE namespace = ? AND topic = ?`,
    )
    .get(namespace, topic) as Record<string, unknown> | undefined;
  return row ? toEntry(row) : undefined;
}

export function listEntries(db: DatabaseSync, namespace: string): Entry[] {
  return (
    db
      .prepare(
        `SELECT id, namespace, topic, summary, created_at FROM entries
         WHERE namespace = ? ORDER BY topic`,
      )
      .all(namespace) as Record<string, unknown>[]
  ).map(toEntry);
}

export function readContents(db: DatabaseSync, entryId: number): ContentBlock[] {
  return (
    db
      .prepare(`SELECT text, session, step, at FROM contents WHERE entry_id = ? ORDER BY id`)
      .all(entryId) as Record<string, unknown>[]
  ).map((r) => ({
    text: String(r["text"]),
    session: String(r["session"]),
    step: String(r["step"]),
    at: String(r["at"]),
  }));
}

/** Entries with an embedding, for the gatekeeper's nearest-topic prefilter. */
export function listEmbedded(
  db: DatabaseSync,
  namespace: string,
): { entry: Entry; embedding: Float32Array }[] {
  return (
    db
      .prepare(
        `SELECT id, namespace, topic, summary, created_at, embedding FROM entries
         WHERE namespace = ? AND embedding IS NOT NULL`,
      )
      .all(namespace) as Record<string, unknown>[]
  ).map((row) => ({
    entry: toEntry(row),
    embedding: fromBlob(row["embedding"] as Uint8Array),
  }));
}

export function search(db: DatabaseSync, namespace: string, query: string, limit = 10): Entry[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.namespace, e.topic, e.summary, e.created_at
       FROM entries_fts f JOIN entries e ON e.id = f.rowid
       WHERE entries_fts MATCH ? AND e.namespace = ?
       ORDER BY rank LIMIT ?`,
    )
    .all(query, namespace, limit) as Record<string, unknown>[];
  return rows.map(toEntry);
}

export function logRejection(
  db: DatabaseSync,
  namespace: string,
  candidate: string,
  verdict: string,
  reason: string,
  provenance: Provenance,
): void {
  db.prepare(
    `INSERT INTO rejections (namespace, candidate, verdict, reason, session, step, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    namespace,
    candidate,
    verdict,
    reason,
    provenance.session,
    provenance.step,
    new Date().toISOString(),
  );
}

export function rejectionCount(db: DatabaseSync, namespace: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM rejections WHERE namespace = ?`)
    .get(namespace) as { n: number };
  return Number(row.n);
}

function readBody(db: DatabaseSync, entryId: number): string {
  return readContents(db, entryId)
    .map((c) => c.text)
    .join("\n");
}

function reindex(
  db: DatabaseSync,
  entryId: number,
  topic: string,
  summary: string,
  body: string,
): void {
  db.prepare(`DELETE FROM entries_fts WHERE rowid = ?`).run(entryId);
  db.prepare(`INSERT INTO entries_fts (rowid, topic, summary, body) VALUES (?, ?, ?, ?)`).run(
    entryId,
    topic,
    summary,
    body,
  );
}

const toEntry = (row: Record<string, unknown>): Entry => ({
  id: Number(row["id"]),
  namespace: String(row["namespace"]),
  topic: String(row["topic"]),
  summary: String(row["summary"]),
  createdAt: String(row["created_at"]),
});
