import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config/schema.ts";
import { callModel } from "../model/call.ts";
import { resolveStepModel } from "../model/roles.ts";
import { loadPrompt } from "../prompts/load.ts";
import { render } from "../prompts/render.ts";
import { embedText, nearest, type Neighbour } from "./similarity.ts";
import {
  appendContent,
  createEntry,
  findEntry,
  logRejection,
  type Entry,
  type Provenance,
} from "./store.ts";

/**
 * The only write path into the knowledge store. No step writes entries
 * directly.
 *
 * Deduplication happens here, at write time, as a classification against a
 * short list — not later, as similarity search over unbounded text. That is a
 * problem a small model can actually do.
 */

const NONE = "none";
const STEP_NAME = "knowledge_gatekeeper";

export type Verdict = "append" | "new" | "collides" | "reject";

export interface GatekeeperResult {
  verdict: Verdict;
  reason: string;
  /** The entry written to, when one was. */
  entry?: Entry;
  neighbours: Neighbour[];
}

function buildSchema(topics: readonly string[]) {
  const options: [string, ...string[]] = [NONE, ...topics];
  return z.object({
    reason: z.string(),
    verdict: z.enum(["append", "new", "collides", "reject"]),
    existing_topic: z.enum(options),
    new_topic: z.string(),
    summary: z.string(),
  });
}

export interface WriteOptions {
  db: DatabaseSync;
  config: Config;
  namespace: string;
  candidate: string;
  provenance: Provenance;
  /** How many neighbours to show the model. Kept short on purpose. */
  shortlist?: number;
  promptsDir?: string | undefined;
}

export async function writeKnowledge(opts: WriteOptions): Promise<GatekeeperResult> {
  const { db, config, namespace, candidate, provenance } = opts;
  const shortlist = opts.shortlist ?? 8;

  const vector = await embedText(config, candidate);
  const neighbours = nearest(db, namespace, vector, shortlist);
  const topics = neighbours.map((n) => n.entry.topic);

  const model = resolveStepModel(config, STEP_NAME, "fast");
  const prompt = await loadPrompt(STEP_NAME, { dir: opts.promptsDir });

  const rendered = render(prompt.text, {
    candidate,
    nearest_topics:
      neighbours.length > 0
        ? neighbours.map((n) => `- \`${n.entry.topic}\` — ${n.entry.summary}`).join("\n")
        : "(the store is empty — nothing to overlap with)",
  });

  const result = await callModel({
    label: STEP_NAME,
    host: config.ollama.host,
    role: model.role,
    prompt: rendered,
    schema: buildSchema(topics),
    // Rejecting on a parse failure is the conservative default: a bad entry is
    // permanent and pollutes every future lookup, where a dropped one is merely
    // lost. The rejection is logged either way.
    fallback: () => ({
      reason: "Gatekeeper response could not be parsed.",
      verdict: "reject" as const,
      existing_topic: NONE,
      new_topic: "",
      summary: "",
    }),
    timeoutMs: model.timeoutMs,
  });

  const { verdict, reason, existing_topic, new_topic, summary } = result.value;

  if (verdict === "reject") {
    logRejection(db, namespace, candidate, verdict, reason, provenance);
    return { verdict, reason, neighbours };
  }

  if (verdict === "append") {
    const target = existing_topic !== NONE ? findEntry(db, namespace, existing_topic) : undefined;
    if (!target) {
      // The model chose `append` without naming a resolvable topic. Logged as a
      // rejection rather than guessed at — filing text under the wrong entry is
      // worse than not filing it.
      logRejection(db, namespace, candidate, "append_unresolved", reason, provenance);
      return { verdict: "reject", reason: `append to unknown topic "${existing_topic}"`, neighbours };
    }
    appendContent(db, target.id, candidate, provenance);
    return { verdict, reason, entry: target, neighbours };
  }

  // `new` and `collides` both create an entry; `collides` differs only in that
  // the model was asked to qualify the name against a near-miss.
  const topic = new_topic.trim().toLowerCase();
  if (topic === "") {
    logRejection(db, namespace, candidate, "missing_topic", reason, provenance);
    return { verdict: "reject", reason: "no topic proposed", neighbours };
  }

  const existing = findEntry(db, namespace, topic);
  if (existing) {
    // Proposed a name already in use — treat it as the append the model meant.
    appendContent(db, existing.id, candidate, provenance);
    return { verdict: "append", reason, entry: existing, neighbours };
  }

  // Within one process this cannot fail on the unique constraint: `node:sqlite`
  // is synchronous and there is no `await` between the lookup above and this
  // call, so nothing can interleave. It *can* fail across processes — two
  // daemons pointed at one instance directory share the file — and losing a
  // write to an unhandled exception there would be a poor trade for a race
  // nobody should be running into anyway.
  let entry: Entry;
  try {
    entry = createEntry(db, namespace, topic, summary.trim(), vector, provenance);
  } catch (cause) {
    const raced = findEntry(db, namespace, topic);
    if (!raced) throw cause;
    appendContent(db, raced.id, candidate, provenance);
    return { verdict: "append", reason, entry: raced, neighbours };
  }
  appendContent(db, entry.id, candidate, provenance);
  return { verdict, reason, entry, neighbours };
}
