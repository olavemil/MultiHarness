import { z } from "zod";
import type { Config } from "../config/schema.ts";
import { buildContext } from "../context/builder.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import { WINDOW_LIMIT } from "../context/blocks/messageWindow.ts";
import { resolveLocalId, windowEntries, windowIds } from "../core/window.ts";
import { callModel, type CallTrace } from "../model/call.ts";
import { resolveStepModel } from "../model/roles.ts";
import { loadPrompt } from "../prompts/load.ts";
import { render } from "../prompts/render.ts";

/**
 * Answers "which earlier message is this a reply to?".
 *
 * Replaces a positional heuristic with a judgement. Distance from the agent's
 * last message only ever *approximated* "is this aimed at me", and approximating
 * it is precisely what the small models were unreliable at.
 *
 * Not a pipeline step: its output is an input to routing, like mention
 * detection, rather than a work product. It is traced, but nothing is sealed.
 */

export const NOTHING = "nothing";

/** Who the incoming message is replying to, once the local id is resolved. */
export type ReplyTargetKind = "agent" | "other" | "nothing";

export interface ReplyTarget {
  kind: ReplyTargetKind;
  /** The window-local id chosen, e.g. `m4`. Absent when nothing was chosen. */
  localId?: string;
  reason: string;
  trace: CallTrace;
}

/**
 * The schema is compiled from the ids actually in the window, so constrained
 * decoding cannot emit a reference to a message that is not there.
 */
function buildSchema(ids: readonly string[]) {
  // `nothing` leads, so the tuple is non-empty even for an empty window.
  const options: [string, ...string[]] = [NOTHING, ...ids];
  return z.object({
    reason: z.string(),
    target: z.enum(options),
  });
}

export async function resolveReplyTarget(
  config: Config,
  blockInput: BlockInput,
  opts: { promptsDir?: string | undefined; rng?: (() => number) | undefined } = {},
): Promise<ReplyTarget> {
  const entries = windowEntries(blockInput.history, WINDOW_LIMIT);
  const ids = windowIds(entries);
  const schema = buildSchema(ids);

  const stepName = "reply_target";
  const model = resolveStepModel(config, stepName, "fast");
  const prompt = await loadPrompt(stepName, { dir: opts.promptsDir, rng: opts.rng });
  const context = await buildContext(["message_window", "incoming_message"], blockInput, config);

  const rendered = render(prompt.text, {
    ...context.variables,
    agent_name: config.agent.name,
  });

  const result = await callModel({
    label: stepName,
    host: config.ollama.host,
    role: model.role,
    prompt: rendered,
    schema,
    // Claiming a reply target on a parse failure would invent a conversational
    // link that may not exist; `nothing` asserts the least.
    fallback: () => ({ reason: "Could not be parsed; assuming no reply target.", target: NOTHING }),
    timeoutMs: model.timeoutMs,
  });

  const { target, reason } = result.value;
  if (target === NOTHING) {
    return { kind: NOTHING, reason, trace: result.trace };
  }

  const message = resolveLocalId(entries, target);
  return {
    kind: message?.fromAgent ? "agent" : "other",
    localId: target,
    reason,
    trace: result.trace,
  };
}
