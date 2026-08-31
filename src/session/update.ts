import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { InboundMessage } from "../core/types.ts";
import { callModel, type CallTrace } from "../model/call.ts";
import { hostFor, resolveStepModel } from "../model/roles.ts";
import { loadPrompt } from "../prompts/load.ts";
import { render } from "../prompts/render.ts";

/**
 * The in-flight supervisor check.
 *
 * Runs on `fast` *alongside* a step, not before it, and judges relevance —
 * "is this still the right step, given what just arrived?" — never progress.
 * It sees the step's headline and the new messages, never partial output:
 * mid-generation tokens are noise, and a step's name plus its topic is a
 * well-defined snapshot that costs nothing to produce.
 *
 * Distinct from `react`, which shares its family and answers a different
 * question. Keeping the names apart keeps config and traces legible.
 *
 * **Four verdicts, not five.** `defer_to_session` was removed after its eval
 * scored 0/3 three times running, each time correctly. The intent was "this one
 * needs a session of its own" — but an arrival the session does not act on is
 * *left in the inbox* and gets one anyway, so the verdict never named a distinct
 * action. It briefly appeared to earn its place when `continue` was made to
 * consume arrivals; that turned out to be the mistake, not the fix.
 *
 * What consumption means now: `adjust` and `respond_now` mean the session
 * changed what it was doing because of the message, so it owns it. `continue`
 * and `abort` do not, so the message stays queued for a session of its own.
 */

export const UPDATE_VERDICTS = [
  "continue",
  "adjust",
  "abort",
  "respond_now",
] as const;

export type UpdateVerdict = (typeof UPDATE_VERDICTS)[number];

const schema = z.object({
  reason: z.string(),
  verdict: z.enum(UPDATE_VERDICTS),
});

export interface UpdateResult {
  verdict: UpdateVerdict;
  reason: string;
  trace: CallTrace;
}

export interface UpdateRequest {
  config: Config;
  /** The step in flight: its name and the topic it was given. */
  stepName: string;
  topic: string;
  pending: readonly InboundMessage[];
  promptsDir?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function runUpdate(req: UpdateRequest): Promise<UpdateResult> {
  const model = resolveStepModel(req.config, "update", "fast");
  const prompt = await loadPrompt("update", { dir: req.promptsDir });

  const rendered = render(prompt.text, {
    agent_name: req.config.agent.name,
    step_name: req.stepName,
    step_topic: req.topic || "(no specific topic)",
    new_messages: req.pending.map((m) => `${m.authorName}: ${m.text}`).join("\n"),
  });

  const result = await callModel({
    label: "update",
    host: hostFor(req.config, model.role),
    role: model.role,
    prompt: rendered,
    schema,
    // Continuing is the conservative default: a step already underway has
    // already been paid for, and abandoning it on a parse failure wastes that
    // and leaves the person waiting with nothing.
    fallback: () => ({ reason: "Update could not be parsed; letting the step finish.", verdict: "continue" as const }),
    timeoutMs: model.timeoutMs,
    signal: req.signal,
  });

  return { verdict: result.value.verdict, reason: result.value.reason, trace: result.trace };
}
