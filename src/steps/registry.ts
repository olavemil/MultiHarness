import type { AnyStep } from "./types.ts";
import { adjust } from "./adjust.ts";
import { compact } from "./compact.ts";
import { debrief } from "./debrief.ts";
import { draft } from "./draft.ts";
import { impression } from "./impression.ts";
import { plan } from "./plan.ts";
import { ponder } from "./ponder.ts";
import { initiate } from "./initiate.ts";
import { outreach } from "./outreach.ts";
import { prune } from "./prune.ts";
import { schedule } from "./schedule.ts";
import { selfSummary } from "./selfSummary.ts";
import { read } from "./read.ts";
import { stance } from "./stance.ts";
import { reason } from "./reason.ts";
import { research } from "./research.ts";
import { reflect } from "./reflect.ts";
import { respond } from "./respond.ts";
import { restate } from "./restate.ts";
import { review } from "./review.ts";
import { summarize } from "./summarize.ts";

/** Adding a step: one file above, one line here, one prompt, one config entry. */
const ALL: readonly AnyStep[] = [
  reflect,
  read,
  stance,
  restate,
  schedule,
  selfSummary,
  adjust,
  plan,
  research,
  reason,
  draft,
  respond,
  summarize,
  review,
  debrief,
  impression,
  compact,
  prune,
  ponder,
  initiate,
  outreach,
];

const REGISTRY: ReadonlyMap<string, AnyStep> = new Map(ALL.map((step) => [step.name, step]));

export const KNOWN_STEP_NAMES: readonly string[] = ALL.map((step) => step.name);

export function getStep(name: string): AnyStep {
  const step = REGISTRY.get(name);
  if (!step) {
    throw new Error(`Unknown step "${name}". Known steps: ${KNOWN_STEP_NAMES.join(", ")}.`);
  }
  return step;
}

export function hasStep(name: string): boolean {
  return REGISTRY.has(name);
}
