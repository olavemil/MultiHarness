import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config/schema.ts";
import { recordCuriosity } from "../knowledge/curiosity.ts";
import type { Provenance } from "../knowledge/store.ts";
import type { Research } from "../steps/research.ts";
import type { Thoughts } from "../steps/reason.ts";
import type { Debrief } from "../steps/debrief.ts";

export interface HarvestEvent {
  step: string;
  question: string;
  outcome: "recorded" | "dropped" | "error";
  curiosityId?: number;
  reason?: string;
}

export interface HarvestResult {
  recorded: number;
  events: HarvestEvent[];
}

/**
 * The open questions a step just reported, pulled out of its sealed output.
 *
 * **Nothing is judged here.** Each of these fields already exists, is already
 * written by a step that was asked exactly the right question, and was already
 * discarded at session end:
 *
 * - `research.gaps` — "anything you could not establish that would have changed
 *   the answer"
 * - `reason.uncertainties` — "what would change the conclusion if it turned out
 *   otherwise"
 * - `debrief.unanswered` — a question somebody asked that nothing answered
 *
 * Harvesting them is a copy, not a judgement, which is why it costs no model
 * call and why it follows the rule the rest of the entry path runs on: a fact
 * the harness can establish is never asked of a model. Asking a step "what are
 * you curious about?" would be the self-assessment shape this project has been
 * bitten by every time — the same failure as "have you made progress?".
 *
 * The filtering happens at *selection*, not at capture: which open question is
 * worth spending idle time on is a far better question than which one was worth
 * writing down, and recurrence answers it without anybody being asked.
 */
export function loose(stepName: string, value: unknown): string[] {
  switch (stepName) {
    case "research":
      return (value as Research).gaps ?? [];
    case "reason":
      return (value as Thoughts).uncertainties ?? [];
    case "debrief":
      return (value as Debrief).unanswered ?? [];
    default:
      return [];
  }
}

/**
 * Records them, merging each into an existing open question where it is the
 * same one asked differently.
 *
 * Never throws. This runs at the tail of a step that has already done its work,
 * and an unreachable embedding model must not cost the session that ran it.
 */
export async function harvest(args: {
  db: DatabaseSync;
  config: Config;
  channelId: string;
  stepName: string;
  value: unknown;
  provenance: Provenance;
}): Promise<number> {
  const result = await harvestWithTrace(args);
  return result.recorded;
}

/**
 * Same harvest path, but returns per-question outcomes for session tracing.
 */
export async function harvestWithTrace(args: {
  db: DatabaseSync;
  config: Config;
  channelId: string;
  stepName: string;
  value: unknown;
  provenance: Provenance;
}): Promise<HarvestResult> {
  if (!args.config.session.curiosity.enabled) return { recorded: 0, events: [] };

  const questions = loose(args.stepName, args.value);
  let recorded = 0;
  const events: HarvestEvent[] = [];
  for (const question of questions) {
    const text = question.trim();
    if (text === "") {
      events.push({
        step: args.stepName,
        question,
        outcome: "dropped",
        reason: "empty question",
      });
      continue;
    }

    try {
      const kept = await recordCuriosity(
        args.db,
        args.config,
        text,
        args.channelId,
        args.provenance,
      );
      if (kept) {
        recorded++;
        events.push({
          step: args.stepName,
          question: text,
          outcome: "recorded",
          curiosityId: kept.id,
        });
      } else {
        events.push({
          step: args.stepName,
          question: text,
          outcome: "dropped",
          reason: "recordCuriosity returned undefined",
        });
      }
    } catch (cause) {
      // One unrecordable question must not stop the rest, and none of them is
      // worth a failed session.
      events.push({
        step: args.stepName,
        question: text,
        outcome: "error",
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { recorded, events };
}
