import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config/schema.ts";
import { recordCuriosity } from "../knowledge/curiosity.ts";
import type { Provenance } from "../knowledge/store.ts";
import type { Research } from "../steps/research.ts";
import type { Thoughts } from "../steps/reason.ts";
import type { Debrief } from "../steps/debrief.ts";

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
  if (!args.config.session.curiosity.enabled) return 0;

  const questions = loose(args.stepName, args.value);
  let recorded = 0;
  for (const question of questions) {
    try {
      const kept = await recordCuriosity(
        args.db,
        args.config,
        question,
        args.channelId,
        args.provenance,
      );
      if (kept) recorded++;
    } catch {
      // One unrecordable question must not stop the rest, and none of them is
      // worth a failed session.
    }
  }
  return recorded;
}
