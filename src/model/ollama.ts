/**
 * Minimal ollama HTTP client. Deliberately not a framework: this file knows
 * about HTTP and NDJSON, and nothing about steps, prompts, or sessions.
 *
 * No step calls this directly — everything goes through `model/call.ts`, which
 * is where the schema-validation rule is enforced.
 */

import { createDeadline } from "./deadline.ts";

export type OptionValue = number | string | boolean;

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "agent" | "tool";
  content: string;
  /** Present on agent turns that asked for tools. */
  tool_calls?: ToolCall[];
  /** Names the tool a `role: "tool"` message is answering. */
  tool_name?: string;
}

/** Ollama's function-calling declaration. */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /**
   * JSON Schema for constrained decoding. Mutually exclusive with `tools` in
   * practice: forcing the output shape leaves no room for a tool call.
   */
  format?: unknown;
  tools?: ToolSpec[];
  options?: Record<string, OptionValue>;
  keepAlive?: number | string;
  think?: boolean;
}

export interface ChatResult {
  content: string;
  /** Tools the model asked for on this turn. Empty when it answered directly. */
  toolCalls: ToolCall[];
  /**
   * Reasoning emitted before the answer, when the model has thinking enabled.
   * Streamed on a separate field and excluded from `eval_count`, so a step can
   * spend most of its wallclock here while appearing to produce almost nothing.
   * Captured so the trace reflects what actually happened.
   */
  thinking: string;
  model: string;
  promptTokens: number;
  responseTokens: number;
  durationMs: number;
}

export interface ChatCallOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Called with each streamed fragment, for the step's working file. */
  onDelta?: ((chunk: string) => void) | undefined;
}

interface StreamChunk {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaError extends Error {
  readonly status: number | undefined;

  // Written out rather than declared as a constructor parameter property:
  // Node's strip-only TypeScript mode rejects those, and the daemon runs under
  // plain `node` with no transpile step.
  constructor(message: string, status?: number) {
    super(message);
    this.name = "OllamaError";
    this.status = status;
  }
}

/**
 * A call that ran out of time, carrying whatever had already streamed.
 *
 * The partial matters: a 27B with thinking on can produce a complete JSON object
 * bar its closing brace and then hit the deadline, and discarding a ten-minute
 * step over a missing `}` is the worst available outcome. `call.ts` tries to
 * salvage it before falling back.
 */
export class OllamaTimeout extends OllamaError {
  readonly timedOut: boolean;
  readonly partialContent: string;
  readonly partialThinking: string;

  constructor(message: string, timedOut: boolean, content: string, thinking: string) {
    super(message);
    this.name = "OllamaTimeout";
    this.timedOut = timedOut;
    this.partialContent = content;
    this.partialThinking = thinking;
  }
}

/**
 * Streams a chat completion, aggregating deltas into the final content.
 *
 * Throws `OllamaError` on transport or server failure. Those are infrastructure
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
    throw new OllamaError(`ollama request to ${host} failed: ${describe(cause)}`);
  }

  if (!response.ok) {
    throw new OllamaError(
      `ollama returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }
  if (!response.body) throw new OllamaError("ollama returned an empty body");

  let content = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  let promptTokens = 0;
  let responseTokens = 0;

  try {
    for await (const chunk of readNdjson<StreamChunk>(response.body)) {
      if (chunk.error) throw new OllamaError(`ollama stream error: ${chunk.error}`);

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
    if (cause instanceof OllamaError) throw cause;
    // A timeout mid-stream aborts the body iteration rather than the initial
    // fetch, so it arrives here as a bare DOMException. A thinking model can
    // stream for a long time before producing any content, which makes this the
    // *likely* timeout path, not an edge case.
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    const slept = deadline.suspendedMs();
    throw new OllamaTimeout(
      timedOut
        ? `ollama call to ${request.model} exceeded ${opts.timeoutMs}ms of running time ` +
          `(${thinking.length} chars of thinking, ${content.length} of content received` +
          `${slept > 0 ? `; ${Math.round(slept / 1000)}s of machine suspension was not counted` : ""})`
        : `ollama stream failed: ${describe(cause)}`,
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

export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

/** Unused until the knowledge store's gatekeeper prefilter lands. */
export async function embed(
  host: string,
  model: string,
  input: string | string[],
  opts: ChatCallOptions,
): Promise<EmbedResult> {
  const signals = [AbortSignal.timeout(opts.timeoutMs)];
  if (opts.signal) signals.push(opts.signal);

  const response = await fetch(new URL("/api/embed", host), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.any(signals),
  });

  if (!response.ok) {
    throw new OllamaError(
      `ollama embed returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      response.status,
    );
  }

  const json = (await response.json()) as { embeddings?: number[][] };
  return { embeddings: json.embeddings ?? [], model };
}

/** Splits a byte stream into newline-delimited JSON values. */
async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }

  const tail = buffer.trim();
  if (tail) yield JSON.parse(tail) as T;
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
