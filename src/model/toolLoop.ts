import { z } from "zod";
import { chat, type ChatMessage, type ToolSpec } from "./ollama.ts";
import type { ResolvedRole } from "./roles.ts";
import type { AnyTool, ToolCallRecord, ToolContext } from "../tools/types.ts";

/**
 * A step with tools runs as an iterating loop: call, execute what the model
 * asked for, feed the results back, repeat until it stops asking.
 *
 * The loop is deliberately separate from `callModel`. Constrained decoding and
 * tool calling cannot both be in force — forcing the output shape leaves the
 * model no room to emit a tool call — so a step with tools gathers here first,
 * unconstrained, and the caller then makes one schema-shaped call over the
 * transcript. Every step output stays schema-validated either way.
 */

export interface ToolLoopResult {
  calls: ToolCallRecord[];
  /** Readable record of what was asked and answered, for the final prompt. */
  transcript: string;
  /** True when the iteration cap stopped the loop rather than the model. */
  exhausted: boolean;
}

export interface ToolLoopRequest {
  label: string;
  host: string;
  role: ResolvedRole;
  prompt: string;
  tools: readonly AnyTool[];
  context: ToolContext;
  timeoutMs: number;
  maxIterations?: number;
  signal?: AbortSignal | undefined;
}

export const toolSpec = (tool: AnyTool): ToolSpec => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.parameters),
  },
});

export async function runToolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
  const maxIterations = req.maxIterations ?? 6;
  const byName = new Map(req.tools.map((tool) => [tool.name, tool]));
  const specs = req.tools.map(toolSpec);

  const messages: ChatMessage[] = [{ role: "user", content: req.prompt }];
  const calls: ToolCallRecord[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await chat(
      req.host,
      {
        model: req.role.model,
        messages: [...messages],
        tools: specs,
        options: req.role.options,
        ...(req.role.keepAlive !== undefined ? { keepAlive: req.role.keepAlive } : {}),
        ...(req.role.think !== undefined ? { think: req.role.think } : {}),
      },
      { timeoutMs: req.timeoutMs, signal: req.signal },
    );

    if (response.toolCalls.length === 0) {
      // The model answered instead of calling anything; the loop is done.
      if (response.content.trim() !== "") {
        messages.push({ role: "agent", content: response.content });
      }
      return { calls, transcript: renderTranscript(calls), exhausted: false };
    }

    messages.push({
      role: "agent",
      content: response.content,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const record = await execute(byName, call.function.name, call.function.arguments, req.context);
      calls.push(record);
      messages.push({ role: "tool", tool_name: record.name, content: record.result });
    }
  }

  console.warn(
    `[tools:${req.label}] stopped after ${maxIterations} iterations with the model still ` +
      `calling tools; continuing with what it gathered.`,
  );
  return { calls, transcript: renderTranscript(calls), exhausted: true };
}

async function execute(
  byName: Map<string, AnyTool>,
  name: string,
  args: unknown,
  context: ToolContext,
): Promise<ToolCallRecord> {
  const started = Date.now();
  const tool = byName.get(name);

  // A tool outside the allowlist is refused as a tool result rather than
  // thrown: the model asked for something it was not given, which it can
  // recover from, and the step should not die over it.
  if (!tool) {
    const available = [...byName.keys()].join(", ") || "(none)";
    return {
      name,
      args,
      result: `No tool named "${name}" is available here. Available: ${available}.`,
      durationMs: Date.now() - started,
      error: "not allowed",
    };
  }

  const parsed = tool.parameters.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      name,
      args,
      result: `Arguments rejected: ${issues}. Call ${name} again with corrected arguments.`,
      durationMs: Date.now() - started,
      error: issues,
    };
  }

  try {
    const result = await tool.run(parsed.data, context);
    return { name, args, result, durationMs: Date.now() - started };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      name,
      args,
      result: `The tool failed: ${detail}`,
      durationMs: Date.now() - started,
      error: detail,
    };
  }
}

function renderTranscript(calls: readonly ToolCallRecord[]): string {
  if (calls.length === 0) return "(no tools were used)";
  return calls
    .map((call) => `### ${call.name}(${JSON.stringify(call.args)})\n${call.result}`)
    .join("\n\n");
}
