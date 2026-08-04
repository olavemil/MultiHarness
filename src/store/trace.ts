import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallTrace } from "../model/call.ts";
import type { BuiltBlock } from "../context/builder.ts";
import type { SessionHandle } from "./sessionStore.ts";

/**
 * Per-step trace. This system is not debuggable without it: a variable pipeline
 * driven by a local model produces behaviour you cannot reconstruct from the
 * sealed output alone.
 */
export interface StepTraceRecord {
  step: string;
  topic: string;
  startedAt: string;
  durationMs: number;
  /** Which prompt variant ran. Absent for non-model steps. */
  variantId?: string | undefined;
  promptPath?: string | undefined;
  /** Deterministic situation fragment, and its own random variant. */
  situation?: string | undefined;
  situationVariantId?: string | undefined;
  mentionsOther?: string | undefined;
  renderedPrompt?: string | undefined;
  rawResponse?: string | undefined;
  parsed?: unknown;
  call?: CallTrace | undefined;
  contextBlocks?: readonly BuiltBlock[] | undefined;
}

/**
 * Writes the rendered prompt, the raw response, and everything else as three
 * files: the first two are read constantly while tuning prompts and benefit
 * from being plain text rather than buried in JSON.
 */
export async function writeStepTrace(
  session: SessionHandle,
  record: StepTraceRecord,
): Promise<void> {
  const base = path.join(session.traceDir, record.step);
  const writes: Promise<void>[] = [];

  if (record.renderedPrompt !== undefined) {
    writes.push(writeFile(`${base}.prompt.md`, record.renderedPrompt, "utf8"));
  }
  if (record.rawResponse !== undefined) {
    writes.push(writeFile(`${base}.raw.txt`, record.rawResponse, "utf8"));
  }

  // Thinking is where the wallclock goes on a reasoning model and it never
  // appears in the sealed output, so it only exists here.
  const thinking = record.call?.attempts.map((a) => a.thinking).filter(Boolean).join("\n\n---\n\n");
  if (thinking) {
    writes.push(writeFile(`${base}.thinking.txt`, thinking, "utf8"));
  }

  const meta = {
    step: record.step,
    topic: record.topic,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    variantId: record.variantId ?? null,
    promptPath: record.promptPath ?? null,
    situation: record.situation ?? null,
    situationVariantId: record.situationVariantId ?? null,
    mentionsOther: record.mentionsOther ?? null,
    model: record.call?.model ?? null,
    role: record.call?.role ?? null,
    fellBack: record.call?.fellBack ?? false,
    attempts: record.call?.attempts.length ?? 0,
    promptTokens: record.call?.promptTokens ?? 0,
    responseTokens: record.call?.responseTokens ?? 0,
    // Characters, not tokens: ollama excludes thinking from eval_count, so
    // there is no honest token figure to report here.
    thinkingChars: record.call?.attempts.reduce((sum, a) => sum + a.thinking.length, 0) ?? 0,
    validationErrors:
      record.call?.attempts.flatMap((a) => (a.validationError ? [a.validationError] : [])) ?? [],
    contextBlocks:
      record.contextBlocks?.map((b) => ({
        name: b.name,
        estimatedTokens: b.estimatedTokens,
        budgetTokens: b.budgetTokens,
        truncated: b.truncated,
      })) ?? [],
    parsed: record.parsed ?? null,
  };

  writes.push(writeFile(`${base}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, "utf8"));
  await Promise.all(writes);
}
