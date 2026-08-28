import { z } from "zod";
import type { ChatMessage, ToolSpec } from "./transport.ts";
import { withModelLease } from "./lease.ts";
import { chatFor, type ResolvedRole } from "./roles.ts";
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
  /** Total time spent queued for an exclusive model. Excluded from the session budget. */
  waitedMs: number;
  /** Total time spent executing tools between model turns. */
  toolMs: number;
}

export interface ToolLoopRequest {
  label: string;
  host: string;
  role: ResolvedRole;
  prompt: string;
  tools: readonly AnyTool[];
  context: ToolContext;
  /**
   * Budget for the **whole loop**, not for each call inside it.
   *
   * It used to be per call, so a step configured at 600s could legitimately run
   * for an hour across six iterations — inside a session whose entire wallclock
   * budget was fifteen minutes. Seen live: `reason` at 1415s and `research` at
   * 546s in one session, which starved every other call on the machine and left
   * the following steps clamped to the dregs of the budget.
   */
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
  const maxIterations = req.maxIterations ?? 16;
  const byName = new Map(req.tools.map((tool) => [tool.name, tool]));
  const specs = req.tools.map(toolSpec);

  const messages: ChatMessage[] = [{ role: "user", content: req.prompt }];
  const calls: ToolCallRecord[] = [];
  let waitedMs = 0;
  let toolMs = 0;

  // Wall-clock deadline for the loop as a whole. Time not spent running model
  // inference is added back as it accrues: waiting for the lease and executing
  // tools are not this step's model-runtime budget.
  const startedAt = Date.now();
  const remaining = () => req.timeoutMs - (Date.now() - startedAt - waitedMs - toolMs);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const left = remaining();
    if (left <= 0) {
      console.warn(
        `[tools:${req.label}] out of time after ${iteration} iteration(s); ` +
          `continuing with what it gathered.`,
      );
      return { calls, transcript: renderTranscript(calls), exhausted: true, waitedMs, toolMs };
    }

    const request = {
      model: req.role.model,
      messages: [...messages],
      tools: specs,
      options: req.role.options,
      ...(req.role.keepAlive !== undefined ? { keepAlive: req.role.keepAlive } : {}),
      ...(req.role.think !== undefined ? { think: req.role.think } : {}),
    };
    const invoke = () => chatFor(req.role)(req.host, request, { timeoutMs: left, signal: req.signal });

    // Leased **per iteration**, not around the whole loop. Each iteration is one
    // call on the weights, which is what the lease is about; the tool execution
    // between them is sqlite and HTTP, and holding the large model through it
    // would block every other channel and instance on work that is not using it.
    //
    // This was missed when the lease was built, and the miss mattered more than
    // anywhere else it could have: `research` and `reason` are the two steps the
    // lease exists for, and they ran their loops entirely unleased while the
    // cheap final call took it dutifully.
    const leased = req.role.exclusive
      ? await withModelLease(req.role.model, invoke, req.signal)
      : { value: await invoke(), waitedMs: 0 };
    waitedMs += leased.waitedMs;
    const response = leased.value;

    if (response.toolCalls.length === 0) {
      // The model answered instead of calling anything; the loop is done.
      if (response.content.trim() !== "") {
        messages.push({ role: "assistant", content: response.content });
      }
      return { calls, transcript: renderTranscript(calls), exhausted: false, waitedMs, toolMs };
    }

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const record = await execute(byName, call.function.name, call.function.arguments, req.context);
      toolMs += record.durationMs;
      calls.push(record);
      messages.push({
        role: "tool",
        tool_name: record.name,
        content: record.result,
        // Only oMLX's chat() ever sets an id; ollama's protocol correlates by
        // name and turn order instead, so this is simply absent there.
        ...(call.id !== undefined ? { tool_call_id: call.id } : {}),
      });
    }
  }

  console.warn(
    `[tools:${req.label}] stopped after ${maxIterations} iterations with the model still ` +
      `calling tools; continuing with what it gathered.`,
  );
  return { calls, transcript: renderTranscript(calls), exhausted: true, waitedMs, toolMs };
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
