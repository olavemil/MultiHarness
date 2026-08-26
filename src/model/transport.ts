/**
 * Wire-independent shapes for talking to a model server, plus the two error
 * types every backend throws on transport failure.
 *
 * Split out of `ollama.ts` when `omlx.ts` arrived: `call.ts` and `toolLoop.ts`
 * already only touched these shapes, never Ollama's raw JSON, so the backend
 * became a choice of *which module implements `chat`/`embed` against this
 * contract* rather than a property baked into the caller. Neither backend name
 * belongs on the error classes a caller catches regardless of which one it
 * used, which is why they moved here renamed rather than staying "Ollama*".
 */

export type OptionValue = number | string | boolean;

export interface ToolCall {
  /**
   * Present when the backend correlates tool results by id (oMLX, and any
   * OpenAI-compatible server). Ollama's protocol has no id — a result is
   * matched by name and turn order — so it is always absent there.
   */
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on agent turns that asked for tools. */
  tool_calls?: ToolCall[];
  /** Names the tool a `role: "tool"` message is answering. */
  tool_name?: string;
  /** Correlates a `role: "tool"` message back to the call it answers, when the backend assigned one. */
  tool_call_id?: string;
}

/** A backend's function-calling declaration. */
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
   * Streamed on a separate field on every backend measured so far, and never
   * counted toward `responseTokens` by any of them.
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

export class ModelError extends Error {
  readonly status: number | undefined;

  // Written out rather than declared as a constructor parameter property:
  // Node's strip-only TypeScript mode rejects those, and the daemon runs under
  // plain `node` with no transpile step.
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelError";
    this.status = status;
  }
}

/**
 * A call that ran out of time, carrying whatever had already streamed.
 *
 * The partial matters: a large model with thinking on can produce a complete
 * JSON object bar its closing brace and then hit the deadline, and discarding
 * a ten-minute step over a missing `}` is the worst available outcome.
 * `call.ts` tries to salvage it before falling back.
 */
export class ModelTimeout extends ModelError {
  readonly timedOut: boolean;
  readonly partialContent: string;
  readonly partialThinking: string;

  constructor(message: string, timedOut: boolean, content: string, thinking: string) {
    super(message);
    this.name = "ModelTimeout";
    this.timedOut = timedOut;
    this.partialContent = content;
    this.partialThinking = thinking;
  }
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

export interface EmbedOptions extends ChatCallOptions {
  /** Passed through untouched where the backend supports it. */
  keepAlive?: number | string | undefined;
  options?: Record<string, unknown> | undefined;
}

/** Splits a byte stream into newline-delimited JSON values. Shared by any NDJSON backend. */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
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

/**
 * Splits a byte stream into Server-Sent Events data payloads, for the
 * OpenAI-compatible streaming shape (`data: {...}\n\n`, terminated by
 * `data: [DONE]`). SSE frames are blank-line-delimited, not newline-delimited,
 * and a `[DONE]` sentinel carries no JSON — both would break `readNdjson`.
 */
export async function* readSse<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = function* (raw: string): Generator<T> {
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") continue;
      yield JSON.parse(payload) as T;
    }
  };

  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      yield* emit(event);
    }
  }

  if (buffer.trim()) yield* emit(buffer);
}

export const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
