import type { Config } from "../src/config/schema.ts";
import { KNOWLEDGE, openMemoryDb } from "../src/knowledge/db.ts";
import { writeKnowledge } from "../src/knowledge/gatekeeper.ts";
import { appendContent, createEntry } from "../src/knowledge/store.ts";
import { embedText } from "../src/knowledge/similarity.ts";
import type { EvalCase, StepAttempt } from "./runner.ts";

/**
 * The gatekeeper is not a pipeline step — it is a write path with its own
 * store state — so it keeps a dedicated runner. Seeding uses real embeddings
 * so the prefilter is exercised as it runs live; a fake vector would make the
 * shortlist meaningless.
 */
const embedCache = new Map<string, number[]>();

async function cachedEmbed(config: Config, text: string): Promise<number[]> {
  const hit = embedCache.get(text);
  if (hit) return hit;
  const vector = await embedText(config, text);
  embedCache.set(text, vector);
  return vector;
}

export async function runGatekeeperCase(
  config: Config,
  testCase: EvalCase,
): Promise<StepAttempt> {
  const db = openMemoryDb();
  const provenance = { session: "eval", step: "research" };

  for (const seed of testCase.store ?? []) {
    const vector = await cachedEmbed(config, seed.seed);
    const entry = createEntry(db, KNOWLEDGE, seed.topic, seed.summary, vector, provenance);
    appendContent(db, entry.id, seed.seed, provenance);
  }

  const started = Date.now();
  const result = await writeKnowledge({
    db,
    config,
    namespace: KNOWLEDGE,
    candidate: testCase.message?.text ?? "",
    provenance,
  });

  return {
    answer: result.verdict,
    reason: `${result.reason}${result.entry ? ` -> ${result.entry.topic}` : ""}`,
    ms: Date.now() - started,
    fellBack: false,
    deterministic: false,
    detail: result.neighbours.length
      ? result.neighbours.map((n) => `${n.entry.topic}=${n.score.toFixed(2)}`).join(" ")
      : "(empty store)",
  };
}
