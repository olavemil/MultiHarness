/**
 * Minimal ollama HTTP client. Deliberately not a framework: this file knows
 * about HTTP and NDJSON, and nothing about steps, prompts, or sessions.
 *
 * No step calls this directly — everything goes through `model/call.ts`, which
 * is where the schema-validation rule is enforced and where the backend named
 * by a role's `backend` field is dispatched to this module or to `omlx.ts`.
 */

import { createDeadline } from "./deadline.ts";
import {
  ModelError,
  ModelTimeout,
  readNdjson,
  describeError,
  type ChatCallOptions,
  type ChatRequest,
  type ChatResult,
  type EmbedOptions,
  type EmbedResult,
  type ToolCall,
} from "./transport.ts";

export type {
  OptionValue,
  ToolCall,
  ChatMessage,
  ToolSpec,
  ChatRequest,
  ChatResult,
  ChatCallOptions,
  EmbedResult,
  EmbedOptions,
} from "./transport.ts";
export { ModelError, ModelTimeout } from "./transport.ts";

interface StreamChunk {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Streams a chat completion, aggregating deltas into the final content.
 *
 * Throws `ModelError` on transport or server failure. Those are infrastructure
 * problems, not parse problems, and are deliberately *not* swallowed into a
 * fallback — a session built on a dead model server should fail loudly rather
 * than quietly emit defaults.
 */
export async function chat(
  host: string,
  request: ChatRequest,
  opts: ChatCallOptions,
): Promise<ChatResult> {
  const started = Date.now();
  // Not `AbortSignal.timeout`: that counts wallclock, so a sleeping laptop
  // fails every in-flight call and blames the model. See `deadline.ts`.
  const deadline = createDeadline(opts.timeoutMs);
  const signals = [deadline.signal];
  if (opts.signal) signals.push(opts.signal);

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
  };
  if (request.format !== undefined) body["format"] = request.format;
  if (request.tools !== undefined && request.tools.length > 0) body["tools"] = request.tools;
  if (request.options !== undefined) body["options"] = request.options;
  if (request.keepAlive !== undefined) body["keep_alive"] = request.keepAlive;
  if (request.think !== undefined) body["think"] = request.think;

  let response: Response;
  try {
    response = await fetch(new URL("/api/chat", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (cause) {
    throw new ModelError(`ollama request to ${host} failed: ${describeError(cause)}`);
  }

  if (!response.ok) {
    throw new ModelError(
      `ollama returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }
  if (!response.body) throw new ModelError("ollama returned an empty body");

  let content = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  let promptTokens = 0;
  let responseTokens = 0;

  try {
    for await (const chunk of readNdjson<StreamChunk>(response.body)) {
      if (chunk.error) throw new ModelError(`ollama stream error: ${chunk.error}`);

      const delta = chunk.message?.content;
      if (delta) {
        content += delta;
        opts.onDelta?.(delta);
      }
      const reasoning = chunk.message?.thinking;
      if (reasoning) thinking += reasoning;

      if (chunk.message?.tool_calls) toolCalls.push(...chunk.message.tool_calls);

      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count ?? 0;
        responseTokens = chunk.eval_count ?? 0;
      }
    }
  } catch (cause) {
    if (cause instanceof ModelError) throw cause;
    // A timeout mid-stream aborts the body iteration rather than the initial
    // fetch, so it arrives here as a bare DOMException. A thinking model can
    // stream for a long time before producing any content, which makes this the
    // *likely* timeout path, not an edge case.
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const slept = deadline.suspendedMs();
    throw new ModelTimeout(
      timedOut
        ? `ollama call to ${request.model} exceeded ${opts.timeoutMs}ms of running time ` +
          `(${thinking.length} chars of thinking, ${content.length} of content received` +
          `${slept > 0 ? `; ${Math.round(slept / 1000)}s of machine suspension was not counted` : ""})`
        : `ollama stream failed: ${describeError(cause)}`,
      timedOut,
      content,
      thinking,
    );
  } finally {
    deadline.release();
  }

  return {
    content,
    toolCalls,
    thinking,
    model: request.model,
    promptTokens,
    responseTokens,
    durationMs: Date.now() - started,
  };
}

/**
 * Three things this used to drop, all harmless while the `embed` role was
 * unused and none of them harmless once `core/standing.ts` put it on the reply
 * path:
 *
 * - **`keep_alive` was never sent**, so `[roles.embed] keep_alive = -1` did
 *   nothing and ollama unloaded the model on its own five-minute default. The
 *   config said pinned and `ollama ps` said four minutes from now.
 * - **`options` was never sent**, so `num_ctx` could not be set at all. The
 *   model loaded at its default 32768 and sat at **5.8 GB resident** against a
 *   639 MB file — the KV cache, as always — which is what actually consumed the
 *   headroom the role table budgeted at "<1 GB".
 * - **`AbortSignal.timeout` counts wallclock across suspension**, the exact
 *   failure `model/deadline.ts` exists to prevent. A laptop sleeping mid-embed
 *   reported the embedding model blowing its deadline.
 */
export async function embed(
  host: string,
  model: string,
  input: string | string[],
  opts: EmbedOptions,
): Promise<EmbedResult> {
  const deadline = createDeadline(opts.timeoutMs);
  const signals = [deadline.signal];
  if (opts.signal) signals.push(opts.signal);

  let response: Response;
  try {
    response = await fetch(new URL("/api/embed", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input,
        ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
        ...(opts.options ? { options: opts.options } : {}),
      }),
      signal: AbortSignal.any(signals),
    });
  } finally {
    deadline.release();
  }

  if (!response.ok) {
    throw new ModelError(
      `ollama embed returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }

  const json = (await response.json()) as { embeddings?: number[][] };
  return { embeddings: json.embeddings ?? [], model };
}
