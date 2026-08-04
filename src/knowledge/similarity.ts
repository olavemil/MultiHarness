import type { DatabaseSync } from "node:sqlite";
import { embed } from "../model/ollama.ts";
import type { Config } from "../config/schema.ts";
import { resolveRole } from "../model/roles.ts";
import { listEmbedded, type Entry } from "./store.ts";

/**
 * Nearest-topic prefilter for the gatekeeper.
 *
 * Without it the gatekeeper's context is the entire topic list, which is fine
 * at 500 topics and hopeless at 5000 — a small model's recall over a long flat
 * list collapses. Embedding the candidate and showing only the nearest handful
 * keeps the judgement on a short list, which is where it stays accurate.
 */

export function cosine(a: Float32Array | readonly number[], b: Float32Array | readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const magnitude = Math.sqrt(na) * Math.sqrt(nb);
  return magnitude === 0 ? 0 : dot / magnitude;
}

export async function embedText(config: Config, text: string): Promise<number[]> {
  const role = resolveRole(config, "embed");
  const result = await embed(config.ollama.host, role.model, text, {
    timeoutMs: config.ollama.request_timeout_ms,
  });
  const vector = result.embeddings[0];
  if (!vector) throw new Error(`Embedding model ${role.model} returned no vector.`);
  return vector;
}

export interface Neighbour {
  entry: Entry;
  score: number;
}

/** The `limit` most similar existing entries, most similar first. */
export function nearest(
  db: DatabaseSync,
  namespace: string,
  vector: readonly number[],
  limit: number,
): Neighbour[] {
  return listEmbedded(db, namespace)
    .map(({ entry, embedding }) => ({ entry, score: cosine(vector, embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
