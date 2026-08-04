import type { AnyStep } from "./types.ts";
import { react } from "./react.ts";
import { reflect } from "./reflect.ts";
import { respond } from "./respond.ts";
import { review } from "./review.ts";
import { summarize } from "./summarize.ts";

/** Adding a step: one file above, one line here, one prompt, one config entry. */
const ALL: readonly AnyStep[] = [reflect, react, respond, summarize, review];

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
