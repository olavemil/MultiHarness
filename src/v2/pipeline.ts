import { reflect } from "./steps/reflect.ts";
import { restate } from "./steps/restate.ts";
import type { StepInput } from "./steps/input.ts";
import type { Step } from "./steps/types.ts";

/**
 * A pipeline is an ordered array of steps with a condition on each.
 *
 * The order is the order they run in, and it is visible here rather than
 * assembled by a ternary inside the session runner. Swapping two steps is
 * moving two lines in this file, which is the whole point of the experiment:
 * the `restate` → `reflect` ordering below is the change v1 could not make
 * cheaply, because the order was welded into control flow and the edges between
 * steps were implicit in thirty closure variables.
 */
export interface Stage<I> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: Step<I, any>;
  /**
   * Whether this stage runs at all.
   *
   * Countable facts only. A model is never asked whether it should run — the
   * same rule that keeps mention detection out of a prompt.
   */
  when?(input: I): boolean;
}

/**
 * The message pipeline.
 *
 * **`restate` precedes `reflect`, reversing v1.** Reflection then reads a
 * settled statement of the task rather than deriving one from a transcript.
 */
export const onMessage: readonly Stage<StepInput>[] = [
  {
    step: restate,
    // A first message in a channel is already self-contained.
    when: (i) => i.message !== undefined && i.history.length > 0,
  },
  {
    step: reflect,
    // Nothing to reflect on in the first session in a channel.
    when: (i) => i.prior !== undefined,
  },
];

export const PIPELINES = { onMessage } as const;
