import { createWriteStream } from "node:fs";
import type { Config } from "../config/schema.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import type { ChannelMessage, CompletedStep, Identity, InboundMessage } from "../core/types.ts";
import { callModel } from "../model/call.ts";
import { resolveStepModel } from "../model/roles.ts";
import { runToolLoop } from "../model/toolLoop.ts";
import { resolveTools } from "../tools/registry.ts";
import { openKnowledgeDb } from "../knowledge/db.ts";
import { appendImpression, impressionCount, readImpressions } from "../knowledge/impressions.ts";
import { detectMention } from "../core/mentions.ts";
import { computeSituation } from "../core/situation.ts";
import { drawParticipation, responseProbability } from "../core/participation.ts";
import { resolveReplyTarget } from "./replyTarget.ts";
import { loadPriorSession, recordLastSession, type PriorSession } from "../store/priorSession.ts";
import { prepareModelStep } from "./prepareStep.ts";
import { getStep } from "../steps/registry.ts";
import type { AnyStep, ModelStep } from "../steps/types.ts";
import type { ToolCallRecord, ToolContext } from "../tools/types.ts";
import type { Reaction } from "../steps/react.ts";
import type { Reflection } from "../steps/reflect.ts";
import type { Impression } from "../steps/impression.ts";
import { saveIdentity } from "../store/identityStore.ts";
import type { Plan } from "../steps/plan.ts";
import type { Response as StepResponse } from "../steps/respond.ts";
import type { Paths } from "../store/paths.ts";
import { createSession, sealStep, workingFilePath, type SessionHandle } from "../store/sessionStore.ts";
import { writeStepTrace } from "../store/trace.ts";

export interface RunSessionOptions {
  config: Config;
  paths: Paths;
  message: InboundMessage;
  identity: Identity;
  history: readonly ChannelMessage[];
  promptsDir?: string | undefined;
  /** Overrides the stored prior session; injectable for tests. */
  prior?: PriorSession | undefined;
  /** Injectable so prompt-variant selection is deterministic under test. */
  rng?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

export interface SessionResult {
  session: SessionHandle;
  completed: CompletedStep[];
  /** The reply to send, absent when the agent chose not to respond. */
  reply?: string;
  reaction?: Reaction;
}

/**
 * Runs one session: the entry step decides, chosen steps run, closing steps
 * always run.
 *
 * Steps execute strictly one at a time. The queue is data rather than control
 * flow, which is what lets `adjust` rewrite it once the supervisor lands.
 */
export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { config, paths, message, identity, history } = opts;
  const startedAt = Date.now();

  const session = await createSession(paths);
  const completed: CompletedStep[] = [];

  // `reflect` needs a previous session in *this channel* to reflect on, so the
  // first session in a channel skips it rather than reflecting on nothing.
  const prior: PriorSession | undefined =
    opts.prior ?? (await loadPriorSession(paths, message.channelId));

  const queue: { name: string; topic: string }[] = [
    ...(prior ? [{ name: config.session.reflect_step, topic: "" }] : []),
    { name: config.session.entry_step, topic: "" },
  ];

  let reaction: Reaction | undefined;
  let reply: string | undefined;
  let closingQueued = false;
  let synthesiseImpression = false;

  // Settled in code, not by the model. See `core/mentions.ts`.
  const mention = detectMention(message.text, config.agent);
  let participationTrace: Record<string, unknown> | undefined;

  // Only worth asking when the agent was not named: being named already settles
  // the decision, and this call exists to inform that decision.
  const replyTarget =
    config.session.reply_target && mention === undefined
      ? await resolveReplyTarget(config, { message, history, identity, completed: [] }, {
          promptsDir: opts.promptsDir,
          rng: opts.rng,
        })
      : undefined;

  // Opened on demand and closed at session end. A daemon runs indefinitely, so
  // a handle left open per session is a handle leaked per session.
  let db: ReturnType<typeof openKnowledgeDb> | undefined;
  const knowledgeDb = () => (db ??= openKnowledgeDb(paths.knowledge));
  let impressions: { text: string }[] = [];

  const blockInput = (): BlockInput => ({
    message,
    history,
    identity,
    completed,
    prior,
    impressions,
  });

  try {
  while (queue.length > 0) {
    const next = queue.shift() as { name: string; topic: string };
    const step = getStep(next.name);

    const ctx = {
      ...opts,
      session,
      startedAt,
      completed,
      blockInput: blockInput(),
      mention,
      replyTarget: replyTarget?.kind,
    };

    // Being named settles whether to reply, full stop — `react` answers only
    // that question now, so there is nothing left for it to decide and no model
    // call to make. Structuring still happens, in `plan`.
    const isEntry = step.name === config.session.entry_step;
    const outcome =
      isEntry && mention !== undefined
        ? await sealDirectReaction(step, mention, ctx)
        : await executeStep(step, next.topic, ctx);

    completed.push(outcome.completed);

    if (step.name === config.session.entry_step) {
      reaction = outcome.value as Reaction;

      // Weighted participation gates the model's "yes"; it can never turn a
      // "no" into a reply, and never silences a message that named the agent.
      const participation = config.session.participation;
      if (participation.enabled) {
        const decision = responseProbability(
          {
            history,
            mentioned: mention !== undefined,
            directFollowup: computeSituation(message.text, history, config.agent).distance === "immediate",
            modelSaidYes: reaction.respond,
          },
          participation,
        );
        const drawn = drawParticipation(decision, opts.rng);
        participationTrace = { ...decision, draw: drawn.draw, spoke: drawn.speak };
        if (!drawn.speak) {
          reaction = {
            ...reaction,
            respond: false,
            reason: `${reaction.reason} (held back: p=${decision.probability.toFixed(3)}, draw=${drawn.draw.toFixed(3)})`,
          };
        }
      }

      if (reaction.respond) {
        // Structuring is a separate question, and only worth asking when there
        // is something to choose between.
        queue.push(
          config.session.selectable_steps.length > 0
            ? { name: config.session.plan_step, topic: "" }
            : { name: config.session.respond_step, topic: "" },
        );
      }
    }

    if (step.name === config.session.plan_step) {
      const chosenPlan = outcome.value as Plan;
      for (const chosen of chosenPlan.steps) {
        queue.push({ name: chosen.step, topic: chosen.topic });
      }
      queue.push({ name: config.session.respond_step, topic: "" });
    }

    if (step.name === config.session.respond_step) {
      reply = (outcome.value as StepResponse).message;
    }

    // `reflect` forms the impression, because it is the step that reads how
    // *they* reacted; `review` judges the agent's own work. The harness records
    // it — reflect runs on `digest` with tools refused and cannot write.
    if (step.name === config.session.reflect_step) {
      const { impression: noticed } = outcome.value as Reflection;
      if (noticed.trim() !== "") {
        appendImpression(knowledgeDb(), identity.id, identity.displayName, noticed, {
          session: session.id,
          step: config.session.reflect_step,
        });
        impressions = readImpressions(knowledgeDb(), identity.id).map((c) => ({ text: c.text }));

        // Synthesise only once enough has accumulated to read as a pattern.
        // Queued for the end of the session rather than here: it costs a digest
        // call, and the fresh summary is for the *next* session to use.
        const total = impressionCount(knowledgeDb(), identity.id);
        synthesiseImpression = total > 0 && total % config.session.impression_threshold === 0;
      }
    }

    if (step.name === "impression") {
      const { summary } = outcome.value as Impression;
      if (summary.trim() !== "") {
        await saveIdentity(paths, { ...identity, summary: summary.trim() });
      }
    }

    // Closing steps go on once every other step has been queued, and are the
    // only thing left after a budget stop.
    if (queue.length === 0 && !closingQueued) {
      closingQueued = true;
      for (const name of config.session.closing_steps) queue.push({ name, topic: "" });
      if (synthesiseImpression) queue.push({ name: "impression", topic: "" });
    } else if (!closingQueued && Date.now() - startedAt > config.session.max_wallclock_ms) {
      console.warn(
        `[session ${session.id}] wallclock budget of ${config.session.max_wallclock_ms}ms ` +
          `exhausted; dropping ${queue.length} remaining step(s) and closing out.`,
      );
      queue.length = 0;
      closingQueued = true;
      for (const name of config.session.closing_steps) queue.push({ name, topic: "" });
    }
  }

  } finally {
    db?.close();
  }

  await recordLastSession(paths, message.channelId, session);

  if (replyTarget) {
    await writeParticipationTrace(session, {
      file: "reply_target",
      kind: replyTarget.kind,
      localId: replyTarget.localId ?? null,
      reason: replyTarget.reason,
      model: replyTarget.trace.model,
      fellBack: replyTarget.trace.fellBack,
      durationMs: replyTarget.trace.durationMs,
    });
  }

  if (participationTrace) {
    await writeParticipationTrace(session, participationTrace);
  }

  return {
    session,
    completed,
    ...(reply !== undefined ? { reply } : {}),
    ...(reaction !== undefined ? { reaction } : {}),
  };
}

interface ExecuteContext extends RunSessionOptions {
  session: SessionHandle;
  startedAt: number;
  completed: readonly CompletedStep[];
  blockInput: BlockInput;
  /** The agent name matched in the incoming message, if any. */
  mention: string | undefined;
  /** What the reply-target step concluded, when it ran. */
  replyTarget?: "agent" | "other" | "nothing" | undefined;
}

/**
 * Produces the entry step's output without a model call, for the case where
 * the agent was named and has no preparatory steps to choose between. Seals and
 * traces exactly like any other step, so the session shape is unchanged.
 */
async function sealDirectReaction(
  step: AnyStep,
  mention: string,
  ctx: ExecuteContext,
): Promise<StepOutcome> {
  const stepStarted = Date.now();
  const startedAtIso = new Date().toISOString();

  const value: Reaction = {
    reason: `Addressed by name ("${mention}"), matched by the harness rather than judged.`,
    respond: true,
  };

  const content = (step as ModelStep<Reaction>).render(value);
  await sealStep(ctx.session, step.outputFile, content);

  const durationMs = Date.now() - stepStarted;
  await writeStepTrace(ctx.session, {
    step: step.name,
    topic: "",
    startedAt: startedAtIso,
    durationMs,
    parsed: value,
  });

  return {
    value,
    completed: { name: step.name, topic: "", outputFile: step.outputFile, content, durationMs },
  };
}

/**
 * Tools reach the knowledge store and nothing else. The database is opened on
 * first use, so a step without knowledge tools never touches sqlite.
 */
function toolContext(ctx: ExecuteContext, stepName: string): ToolContext {
  let db: ReturnType<typeof openKnowledgeDb> | undefined;
  return {
    config: ctx.config,
    knowledge: () => (db ??= openKnowledgeDb(ctx.paths.knowledge)),
    session: ctx.session.id,
    step: stepName,
  };
}

interface StepOutcome {
  completed: CompletedStep;
  value: unknown;
}

async function executeStep(
  step: AnyStep,
  topic: string,
  ctx: ExecuteContext,
): Promise<StepOutcome> {
  return step.kind === "model"
    ? executeModelStep(step, topic, ctx)
    : executeComputedStep(step, topic, ctx);
}

async function executeModelStep(
  step: ModelStep<unknown>,
  topic: string,
  ctx: ExecuteContext,
): Promise<StepOutcome> {
  const { config, session } = ctx;
  const stepStarted = Date.now();
  const startedAtIso = new Date().toISOString();

  const model = resolveStepModel(config, step.name, step.defaultRole, step.defaultTools);
  const prepared = await prepareModelStep({
    step,
    config,
    blockInput: ctx.blockInput,
    mention: ctx.mention,
    replyTarget: ctx.replyTarget,
    topic,
    promptsDir: ctx.promptsDir,
    rng: ctx.rng,
  });
  const { prompt, fragment, situation, context, renderedPrompt } = prepared;

  // A step with tools gathers first, unconstrained, then answers under its
  // schema over what it found. The allowlist has already had the role's
  // `no_tools` veto applied by `resolveStepModel`.
  let toolTranscript = "(no tools were used)";
  let toolCalls: ToolCallRecord[] = [];
  if (model.tools.length > 0) {
    const loop = await runToolLoop({
      label: step.name,
      host: config.ollama.host,
      role: model.role,
      prompt: renderedPrompt,
      tools: resolveTools(model.tools),
      context: toolContext(ctx, step.name),
      timeoutMs: model.timeoutMs,
      signal: ctx.signal,
    });
    toolCalls = loop.calls;
    toolTranscript = loop.transcript;
  }

  const finalPrompt =
    model.tools.length > 0
      ? `${renderedPrompt}\n\n## What the tools returned\n\n${toolTranscript}`
      : renderedPrompt;

  // The running step streams here; it becomes output only when sealed, so a
  // step that dies mid-flight still leaves what it had.
  const working = createWriteStream(workingFilePath(session, step.name), { flags: "w" });

  let result;
  try {
    result = await callModel({
      label: step.name,
      host: config.ollama.host,
      role: model.role,
      prompt: finalPrompt,
      schema: step.buildSchema(config),
      fallback: () => step.fallback(config),
      timeoutMs: model.timeoutMs,
      signal: ctx.signal,
      onDelta: (chunk) => working.write(chunk),
    });
  } finally {
    working.end();
  }

  const content = step.render(result.value);
  await sealStep(session, step.outputFile, content);

  const durationMs = Date.now() - stepStarted;
  await writeStepTrace(session, {
    step: step.name,
    topic,
    startedAt: startedAtIso,
    durationMs,
    variantId: prompt.variantId,
    promptPath: prompt.path,
    situation: situation?.id ?? prepared.fragmentId,
    situationVariantId: fragment?.variantId,
    mentionsOther: situation?.mentionsOther,
    renderedPrompt: finalPrompt,
    rawResponse: result.raw,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    parsed: result.value,
    call: result.trace,
    contextBlocks: context.blocks,
  });

  return {
    value: result.value,
    completed: {
      name: step.name,
      topic,
      outputFile: step.outputFile,
      content,
      durationMs,
      variantId: prompt.variantId,
      fellBack: result.trace.fellBack,
    },
  };
}

async function executeComputedStep(
  step: Extract<AnyStep, { kind: "computed" }>,
  topic: string,
  ctx: ExecuteContext,
): Promise<StepOutcome> {
  const stepStarted = Date.now();
  const startedAtIso = new Date().toISOString();

  const content = await step.compute({
    sessionNumber: ctx.session.number,
    startedAt: ctx.startedAt,
    completed: ctx.completed,
  });
  await sealStep(ctx.session, step.outputFile, content);

  const durationMs = Date.now() - stepStarted;
  await writeStepTrace(ctx.session, { step: step.name, topic, startedAt: startedAtIso, durationMs });

  return {
    value: content,
    completed: { name: step.name, topic, outputFile: step.outputFile, content, durationMs },
  };
}

/**
 * Persists the participation computation. A hidden RNG deciding whether the
 * agent speaks would make "why didn't it answer me?" unanswerable and put every
 * prompt change below the noise floor.
 */
async function writeParticipationTrace(
  session: SessionHandle,
  record: Record<string, unknown>,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const name = typeof record["file"] === "string" ? record["file"] : "participation";
  await writeFile(
    path.join(session.traceDir, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
}
