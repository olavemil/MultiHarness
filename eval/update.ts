import type { Config } from "../src/config/schema.ts";
import { runUpdate } from "../src/session/update.ts";
import { buildInput, type EvalCase, type StepAttempt } from "./runner.ts";

/**
 * `update` is not a pipeline step — it is the supervisor check, taking a step
 * headline rather than a context spec — so it keeps a dedicated runner.
 *
 * A case supplies `step` and `topic` as the work in flight, and `message` as
 * what arrived while it ran.
 */
export async function runUpdateCase(config: Config, testCase: EvalCase): Promise<StepAttempt> {
  const { message } = buildInput(testCase);
  const started = Date.now();

  const result = await runUpdate({
    config,
    stepName: (testCase as { step_name?: string }).step_name ?? "research",
    topic: (testCase as { step_topic?: string }).step_topic ?? "",
    pending: [message],
  });

  return {
    answer: result.verdict,
    reason: result.reason,
    ms: Date.now() - started,
    fellBack: result.trace.fellBack,
    deterministic: false,
    detail: `during ${(testCase as { step_name?: string }).step_name ?? "research"}`,
  };
}
