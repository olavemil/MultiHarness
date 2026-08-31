/**
 * Client for oMLX (github.com/jundot/omlx), a local inference server for
 * Apple Silicon that exposes an OpenAI/Anthropic-compatible API rather than
 * ollama's. Implements the same `chat()`/`embed()` contract as `ollama.ts`
 * against `transport.ts`'s shapes, so `call.ts` and `toolLoop.ts` dispatch to
 * whichever module a role's `backend` names without knowing the difference.
 *
 * **Three request-shape choices here are unverified against a live instance
 * and are recorded as such rather than presented as fact:**
 *
 * - `format` (JSON Schema) is sent as OpenAI's Structured Outputs
 *   `response_format: {type: "json_schema", ...}`. oMLX's own docs describe
 *   JSON-schema-validated *tool calling* but do not explicitly confirm
 *   schema-constrained decoding via `response_format`. Every step's schema
 *   retry/fallback machinery in `call.ts` assumes constrained decoding is
 *   reliable — this is the one assumption that most affects whether this
 *   backend is usable at all, and it wants checking against `test/prompts.test.ts`
 *   or the eval runner before being trusted for anything past `fast`.
 * - `think` is sent as `chat_template_kwargs: { enable_thinking }`, the
 *   convention vLLM/SGLang use for Qwen3's hybrid thinking toggle over an
 *   OpenAI-compatible endpoint. Plausible specifically because the model this
 *   was built for is a Qwen3 build, but oMLX may use a different field name.
 * - Reasoning tokens are read from `delta.reasoning_content`, the
 *   vLLM/DeepSeek-API convention. If oMLX streams reasoning under a different
 *   key, `thinking` silently comes back empty rather than erroring — worth
 *   confirming with a real thinking call before relying on `trace/*.thinking.txt`
 *   for this backend.
 *
 * `keep_alive` has no wire equivalent here: oMLX manages residency itself
 * (TTL / LRU / manual load-unload) rather than per-request, so `[roles.*]
 * keep_alive` is a documented no-op for any role on this backend — `load.ts`
 * warns about it at startup, the same way it warns about placeholder models,
 * rather than the setting silently doing nothing the way `embed`'s did before
 * that was traced down.
 */

import { createDeadline } from "./deadline.ts";
import {
  ModelError,
  ModelTimeout,
  readSse,
  describeError,
  type ChatCallOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type EmbedOptions,
  type EmbedResult,
  type ToolCall,
} from "./transport.ts";

interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamChunk {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/** Accumulates one tool call's streamed fragments, keyed by its `index`. */
interface PendingCall {
  id?: string;
  name: string;
  argsChunks: string[];
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_calls) {
    wire["tool_calls"] = message.tool_calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      type: "function",
      function: {
        name: call.function.name,
        // OpenAI's wire format wants a JSON string here; the harness carries
        // already-parsed arguments internally so every tool only ever handles
        // one shape.
        arguments: JSON.stringify(call.function.arguments),
      },
    }));
  }
  if (message.role === "tool") {
    wire["tool_call_id"] = message.tool_call_id ?? message.tool_name ?? "unknown";
  }
  return wire;
}

/**
 * Streams a chat completion against `/v1/chat/completions`, aggregating SSE
 * deltas the way `ollama.ts#chat` aggregates NDJSON ones. Same failure shape:
 * `ModelError` for transport/server failure, `ModelTimeout` (with whatever had
 * streamed) when the deadline fires mid-response.
 */
export async function chat(
  host: string,
  request: ChatRequest,
  opts: ChatCallOptions,
): Promise<ChatResult> {
  const started = Date.now();
  const deadline = createDeadline(opts.timeoutMs);
  const signals = [deadline.signal];
  if (opts.signal) signals.push(opts.signal);

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.format !== undefined) {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema: request.format },
    };
  }
  if (request.tools !== undefined && request.tools.length > 0) body["tools"] = request.tools;
  if (request.options !== undefined) body["options"] = request.options;
  if (request.think !== undefined) {
    body["chat_template_kwargs"] = { enable_thinking: request.think };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/v1/chat/completions", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (cause) {
    throw new ModelError(`omlx request to ${host} failed: ${describeError(cause)}`);
  }

  if (!response.ok) {
    throw new ModelError(
      `omlx returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }
  if (!response.body) throw new ModelError("omlx returned an empty body");

  let content = "";
  let thinking = "";
  let promptTokens = 0;
  let responseTokens = 0;
  const pending = new Map<number, PendingCall>();

  try {
    for await (const chunk of readSse<StreamChunk>(response.body)) {
      if (chunk.error) {
        const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
        throw new ModelError(`omlx stream error: ${message ?? "unknown error"}`);
      }

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
      if (delta?.reasoning_content) thinking += delta.reasoning_content;

      for (const toolDelta of delta?.tool_calls ?? []) {
        const entry = pending.get(toolDelta.index) ?? { name: "", argsChunks: [] };
        if (toolDelta.id) entry.id = toolDelta.id;
        if (toolDelta.function?.name) entry.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) entry.argsChunks.push(toolDelta.function.arguments);
        pending.set(toolDelta.index, entry);
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        responseTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
  } catch (cause) {
    if (cause instanceof ModelError) throw cause;
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const slept = deadline.suspendedMs();
    throw new ModelTimeout(
      timedOut
        ? `omlx call to ${request.model} exceeded ${opts.timeoutMs}ms of running time ` +
          `(${thinking.length} chars of thinking, ${content.length} of content received` +
          `${slept > 0 ? `; ${Math.round(slept / 1000)}s of machine suspension was not counted` : ""})`
        : `omlx stream failed: ${describeError(cause)}`,
      timedOut,
      content,
      thinking,
    );
  } finally {
    deadline.release();
  }

  const toolCalls: ToolCall[] = [...pending.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({
      id: call.id ?? `call_${index}`,
      function: { name: call.name, arguments: parseArguments(call.argsChunks.join("")) },
    }));

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
 * Malformed streamed arguments become an empty object rather than a thrown
 * error: the tool's own schema validation in `toolLoop.ts#execute` rejects it
 * as a normal tool result, and the model gets a chance to retry — the same
 * recovery path a tool call outside the allowlist already takes. Failing the
 * whole step over one bad `arguments` fragment would be worse than that.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface EmbeddingResponse {
  data?: { embedding: number[]; index: number }[];
}

/**
 * `/v1/embeddings`. `keep_alive` and `options` (e.g. `num_ctx`) have no
 * per-request equivalent on this backend and are not sent — see the module
 * comment. Silently accepting and dropping them here would repeat exactly the
 * failure this project already traced once in `ollama.ts#embed`.
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
    response = await fetch(new URL("/v1/embeddings", host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.any(signals),
    });
  } finally {
    deadline.release();
  }

  if (!response.ok) {
    throw new ModelError(
      `omlx embed returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }

  const json = (await response.json()) as EmbeddingResponse;
  const embeddings = (json.data ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.embedding);
  return { embeddings, model };
}
