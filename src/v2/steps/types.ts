import type { z } from "zod";
import type { Section } from "../compose/section.ts";
import type { ModelRole } from "../values.ts";

/**
 * A step, defined in one place and readable in one sitting.
 *
 * Four differences from v1's `ModelStep`, each answering a specific complaint:
 *
 * 1. **`context` replaces `contextBlocks` + `appendix` + a prompt file with
 *    `${…}` holes.** The array is the prompt, in order, with no hidden nesting.
 * 2. **No `voice`.** Nothing in the prompt is derived from a declared property.
 *    A step that wants onlooker framing names the onlooker fragment. See
 *    `compose/fragments.ts`.
 * 3. **No template variables.** Prose is assembled from typed values, so there
 *    is no render step that can fail on an unsupplied `${name}`, and no
 *    substitution to trace.
 * 4. **`apply` is part of the step.** What a step *changes* is declared beside
 *    what it reads, instead of living as a branch in the session runner.
 */
export interface Step<TInput, TOutput> {
  name: string;
  role: ModelRole;

  /**
   * The prompt, in reading order.
   *
   * Position is meaningful twice over: it is the order the model reads things
   * in, and it is what makes a reference like "the draft above" true. Both are
   * why this is an array and not a dictionary.
   */
  context(input: TInput): readonly Section[];

  schema: z.ZodType<TOutput>;

  /**
   * Used when two attempts fail validation. Local models produce malformed
   * output routinely and a step must never crash a session over it.
   */
  fallback(): TOutput;

  /** The markdown sealed to this step's output file. */
  render(output: TOutput): string;

  outputFile: string;

  /**
   * What running this step changes.
   *
   * Optional, and most steps have none. A step still cannot act on its own
   * authority: the methods on `Effects` route through the same gatekeeper and
   * plan writer the harness uses, so this declares an intent the harness
   * executes rather than performing the write itself.
   */
  apply?(output: TOutput, fx: Effects): void | Promise<void>;

  /** Tools this step may call. An empty or absent list means one direct call. */
  tools?: readonly string[];
}

/**
 * The narrow capability object a step's `apply` receives.
 *
 * Deliberately enumerated rather than handed the session. The moment this can
 * do anything, it is the runner again with an extra layer of indirection.
 */
export interface Effects {
  /** Append an observation about the person this session is talking to. */
  impression(text: string): void;
  /** Hand a candidate to the knowledge gatekeeper, which may refuse it. */
  knowledge(topic: string, text: string): void;
  /** Replace the remaining queue. Budget-checked by the harness. */
  requeue(steps: readonly { step: string; topic: string }[]): void;
  /** Record a value later steps in this session read. */
  note(key: string, value: string): void;
}
