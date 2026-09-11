import type { Config } from "../config/schema.ts";
import { callModel, type CallTrace } from "../model/call.ts";
import { hostFor, resolveStepModel } from "../model/roles.ts";
import { compose } from "./compose/section.ts";
import { onMessage, type Stage } from "./pipeline.ts";
import type { StepInput } from "./steps/input.ts";
import type { Effects } from "./steps/types.ts";

/**
 * The v2 session loop.
 *
 * **Everything below the composition layer is v1's**, and deliberately so:
 * `callModel` for constrained decoding, validation, one retry and a documented
 * fallback; `resolveStepModel` for the role table. Re-implementing those would
 * be re-litigating measurements that were expensive to take, and the experiment
 * is about composition rather than about transport.
 *
 * What differs from `session/run.ts` is the loop body, and it is short enough to
 * read in one sitting: pick the stages whose conditions hold, render each
 * step's own array into a prompt, call, apply the step's own effects, seal.
 * There is no `step.name === …` branch, because there is nowhere for one to go.
 */

export interface V2Result {
  steps: CompletedV2Step[];
  /** Values steps recorded for each other via `fx.note`. */
  notes: Record<string, string>;
  impressions: string[];
  durationMs: number;
}

export interface CompletedV2Step {
  step: string;
  outputFile: string;
  /** The markdown the step sealed. */
  content: string;
  /** Exactly what was sent, so a trace can reproduce it. */
  prompt: string;
  trace: CallTrace;
}

export interface V2Options {
  config: Config;
  input: StepInput;
  /** Overridable so tests drive the loop without a model server. */
  pipeline?: readonly Stage<StepInput>[];
  signal?: AbortSignal | undefined;
  onProgress?: ((line: string) => void) | undefined;
}

export async function runV2Session(opts: V2Options): Promise<V2Result> {
  const { config } = opts;
  const startedAt = Date.now();
  const pipeline = opts.pipeline ?? onMessage;

  const steps: CompletedV2Step[] = [];
  const notes: Record<string, string> = {};
  const impressions: string[] = [];

  // Rebuilt each iteration so a step sees what earlier steps sealed. This is
  // the only mutable state in the loop, against v1's ~30 closure variables —
  // because everything else a step changes goes through `Effects` below.
  let input: StepInput = opts.input;

  const fx: Effects = {
    impression: (text) => {
      if (text.trim()) impressions.push(text.trim());
    },
    // Routed to the same gatekeeper v1 uses once this is wired to a store. A
    // step still never writes on its own authority.
    knowledge: () => {},
    requeue: () => {},
    note: (key, value) => {
      notes[key] = value;
    },
  };

  for (const stage of pipeline) {
    if (stage.when && !stage.when(input)) continue;

    const step = stage.step;
    opts.onProgress?.(`v2: ${step.name}`);

    // The whole prompt, from the step's own array. Nothing is appended here,
    // which is what makes the step file the complete description of the call.
    const prompt = compose(step.context(input));

    const model = resolveStepModel(config, step.name, step.role);
    const result = await callModel({
      label: step.name,
      host: hostFor(config, model.role),
      role: model.role,
      prompt,
      schema: step.schema,
      fallback: step.fallback,
      timeoutMs: model.timeoutMs,
      signal: opts.signal,
    });

    const content = step.render(result.value);

    // Declared on the step, applied here. The only place effects are applied.
    await step.apply?.(result.value, fx);

    steps.push({ step: step.name, outputFile: step.outputFile, content, prompt, trace: result.trace });

    input = { ...input, completed: [...input.completed, { step: step.name, content }] };
  }

  return { steps, notes, impressions, durationMs: Date.now() - startedAt };
}
