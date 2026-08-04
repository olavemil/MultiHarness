import { z } from "zod";
import { chat, type ChatMessage } from "./ollama.ts";
import type { ResolvedRole } from "./roles.ts";

/**
 * The single place the schema rule is enforced. No step talks to `ollama.ts`
 * directly.
 *
 * Local models produce malformed output routinely, so every call is:
 *   constrained decoding -> validate -> retry once with the error fed back ->
 *   documented safe default.
 *
 * This function never throws because of a bad response. It throws only for
 * transport failures (see `OllamaError`), which are an infrastructure problem
 * rather than a parse problem and should not be papered over with a default.
 */

/** One initial attempt plus one retry carrying the validation error. */
const MAX_ATTEMPTS = 2;

export interface CallAttempt {
  /** Exactly what was sent, so the trace can reproduce the call. */
  messages: ChatMessage[];
  raw: string;
  /** Reasoning the model emitted before answering; empty when thinking is off. */
  thinking: string;
  validationError?: string;
  durationMs: number;
  promptTokens: number;
  responseTokens: number;
}

export interface CallTrace {
  label: string;
  role: string;
  model: string;
  attempts: CallAttempt[];
  /** True when both attempts failed validation and the default was used. */
  fellBack: boolean;
  durationMs: number;
  promptTokens: number;
  responseTokens: number;
}

export interface CallResult<T> {
  value: T;
  /** Raw text of the accepted attempt, or of the last one if all failed. */
  raw: string;
  trace: CallTrace;
}

export interface CallRequest<T> {
  /** Identifies the caller in logs and traces — normally the step name. */
  label: string;
  host: string;
  role: ResolvedRole;
  system?: string | undefined;
  prompt: string;
  schema: z.ZodType<T>;
  fallback: () => T;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onDelta?: ((chunk: string) => void) | undefined;
}

export async function callModel<T>(req: CallRequest<T>): Promise<CallResult<T>> {
  const started = Date.now();
  const format = z.toJSONSchema(req.schema);

  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: req.prompt });

  const attempts: CallAttempt[] = [];
  let lastRaw = "";

  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
    const response = await chat(
      req.host,
      {
        model: req.role.model,
        messages: [...messages],
        format,
        options: req.role.options,
        ...(req.role.keepAlive !== undefined ? { keepAlive: req.role.keepAlive } : {}),
        ...(req.role.think !== undefined ? { think: req.role.think } : {}),
      },
      { timeoutMs: req.timeoutMs, signal: req.signal, onDelta: req.onDelta },
    );

    lastRaw = response.content;
    const validated = validate(req.schema, response.content);

    attempts.push({
      messages: [...messages],
      raw: response.content,
      thinking: response.thinking,
      durationMs: response.durationMs,
      promptTokens: response.promptTokens,
      responseTokens: response.responseTokens,
      ...(validated.ok ? {} : { validationError: validated.error }),
    });

    if (validated.ok) {
      return {
        value: validated.value,
        raw: response.content,
        trace: buildTrace(req, attempts, started, false),
      };
    }

    if (attemptNo < MAX_ATTEMPTS) {
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: retryInstruction(validated.error) });
    }
  }

  const lastError = attempts.at(-1)?.validationError ?? "unknown";
  console.warn(
    `[call:${req.label}] ${MAX_ATTEMPTS} attempts failed validation on ` +
      `${req.role.name}/${req.role.model}; using documented default. Last error: ${lastError}`,
  );

  return {
    value: req.fallback(),
    raw: lastRaw,
    trace: buildTrace(req, attempts, started, true),
  };
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function validate<T>(schema: z.ZodType<T>, raw: string): Validated<T> {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `response was not valid JSON (${detail})` };
  }

  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    error: parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; "),
  };
}

/**
 * Recovers JSON from a response that ignored the "JSON only" instruction.
 * Constrained decoding makes this rare, but rare is not never, and one cheap
 * salvage here is one avoided fallback.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();

  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;
  if (body.startsWith("{") || body.startsWith("[")) return body;

  const start = body.search(/[{[]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

const retryInstruction = (error: string): string =>
  `Your previous response did not match the required schema.\n\n` +
  `Validation error:\n${error}\n\n` +
  `Respond again with JSON only — no prose, no code fences — matching the schema exactly.`;

function buildTrace<T>(
  req: CallRequest<T>,
  attempts: CallAttempt[],
  started: number,
  fellBack: boolean,
): CallTrace {
  return {
    label: req.label,
    role: req.role.name,
    model: req.role.model,
    attempts,
    fellBack,
    durationMs: Date.now() - started,
    promptTokens: attempts.reduce((sum, a) => sum + a.promptTokens, 0),
    responseTokens: attempts.reduce((sum, a) => sum + a.responseTokens, 0),
  };
}
