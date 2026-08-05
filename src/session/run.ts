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
import { applyCompaction, compactionCandidates, COMPACT_STEP } from "../knowledge/compaction.ts";
import { KNOWLEDGE } from "../knowledge/db.ts";
import type { ContentBlock } from "../knowledge/store.ts";
import { detectMention } from "../core/mentions.ts";
import { triggeringMessage, type Trigger } from "../core/trigger.ts";
import { computeSituation } from "../core/situation.ts";
import { drawParticipation, responseProbability } from "../core/participation.ts";
import { resolveReplyTarget } from "./replyTarget.ts";
import { loadPriorSession, recordLastSession, type PriorSession } from "../store/priorSession.ts";
import { prepareModelStep } from "./prepareStep.ts";
import { runUpdate, type UpdateVerdict } from "./update.ts";
import {
  checkBudget,
  createBudget,
  describeBudget,
  remainingMs,
  type Budget,
} from "./budget.ts";
import { getStep } from "../steps/registry.ts";
import type { AnyStep, ModelStep } from "../steps/types.ts";
import type { ToolCallRecord, ToolContext } from "../tools/types.ts";
import type { Reaction } from "../steps/react.ts";
import type { Reflection } from "../steps/reflect.ts";
import type { Impression } from "../steps/impression.ts";
import type { Compaction } from "../steps/compact.ts";
import { saveIdentity } from "../store/identityStore.ts";
import type { Adjustment } from "../steps/adjust.ts";
import type { Schedule } from "../steps/schedule.ts";
import type { Response as StepResponse } from "../steps/respond.ts";
import type { Paths } from "../store/paths.ts";
import { createSession, sealStep, workingFilePath, type SessionHandle } from "../store/sessionStore.ts";
import { writeStepTrace } from "../store/trace.ts";

export interface RunSessionOptions {
  config: Config;
  paths: Paths;
  /**
   * Why this session is running. A message is the common case; a maintenance
   * trigger runs the retrospective steps with nothing to reply to.
   */
  trigger: Trigger;
  identity: Identity;
  history: readonly ChannelMessage[];
  promptsDir?: string | undefined;
  /** Overrides the stored prior session; injectable for tests. */
  prior?: PriorSession | undefined;
  /** Injectable so prompt-variant selection is deterministic under test. */
  rng?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Called the moment `respond` seals, before the closing steps run.
   *
   * Without it the reply waits on `summarize`, `review`, and `impression` —
   * ten to twenty seconds of latency after the answer is already written, for
   * work nobody is waiting on.
   */
  onReply?: ((text: string) => Promise<void>) | undefined;
  /**
   * Messages that have arrived for this channel since the session began.
   *
   * The supervisor runs only when this returns something. Supplied by the
   * daemon, which owns the inbox; a session cannot see its own queue.
   */
  pending?: (() => InboundMessage[]) | undefined;
}

export interface SessionResult {
  session: SessionHandle;
  completed: CompletedStep[];
  /** The reply to send, absent when the agent chose not to respond. */
  reply?: string;
  reaction?: Reaction;
  /** Set when the budget cut the session short, with the reason. */
  budgetStop?: string;
  /** Non-`continue` supervisor verdicts, in the order they were applied. */
  supervisorVerdicts?: { step: string; verdict: UpdateVerdict }[];
  /**
   * Arrivals judged to need their own session. The daemon leaves these in the
   * inbox, so they open a session of their own — which is what makes
   * `defer_to_session` an action rather than a note.
   */
  deferred?: { id: string; text: string }[];
  /**
   * Arrivals this session took into account and the daemon should therefore not
   * open a new session for.
   *
   * Without this, a follow-up sent while a session was running started a second
   * session for the same exchange: two sessions, two replies, and the second
   * reasoning about the message with no idea the first was still working. Seen
   * live as `galatea/000006`/`000007`.
   */
  consumed?: string[];
}

/**
 * Runs one session: the entry step decides, chosen steps run, closing steps
 * always run.
 *
 * Steps execute strictly one at a time. The queue is data rather than control
 * flow, which is what lets `adjust` rewrite it once the supervisor lands.
 */
export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { config, paths, trigger, identity, history } = opts;
  const startedAt = Date.now();
  const channelId = trigger.channelId;
  const message = triggeringMessage(trigger);
  const maintenance = trigger.kind === "maintenance";

  const session = await createSession(paths);
  const completed: CompletedStep[] = [];

  // `reflect` needs a previous session in *this channel* to reflect on, so the
  // first session in a channel skips it rather than reflecting on nothing.
  const prior: PriorSession | undefined =
    opts.prior ?? (await loadPriorSession(paths, channelId));

  // A maintenance session has nothing to react to and nobody waiting, so it
  // skips the entry step entirely and runs a fixed queue. There is no decision
  // for a model to make about whether to reply: it may not.
  const queue: { name: string; topic: string }[] = maintenance
    ? (trigger.steps ?? config.session.maintenance.steps)
        // Refused here rather than trusted to config, and refused at queue
        // construction rather than at dispatch: skipping mid-loop would also
        // skip the closing steps, leaving a session directory with no record
        // that anything ran at all.
        .filter((name) => {
          if (name !== config.session.respond_step) return true;
          console.warn(
            `[session] "${name}" is not available to a maintenance session; ignoring it.`,
          );
          return false;
        })
        .map((name) => ({ name, topic: trigger.reason }))
    : [
        ...(prior ? [{ name: config.session.reflect_step, topic: "" }] : []),
        { name: config.session.entry_step, topic: "" },
      ];

  let reaction: Reaction | undefined;
  let reply: string | undefined;
  let closingQueued = false;
  let synthesiseImpression = false;
  let budgetStop: string | undefined;
  const supervisorVerdicts: { step: string; verdict: UpdateVerdict }[] = [];
  let adjusted = false;
  /** Arrivals the supervisor marked as owed their own answer. */
  const deferred: { id: string; text: string }[] = [];
  /**
   * Messages the supervisor has already ruled on. Without this it re-judges the
   * same arrivals at every step boundary — seven `fast` calls for one message
   * in a seven-step session, all reaching the same verdict.
   */
  const judged = new Set<string>();
  /**
   * Arrivals this session absorbed. Reported to the daemon, which drops them
   * from the inbox instead of draining them into sessions of their own.
   */
  const consumedIds = new Set<string>();
  /**
   * What arrived mid-session and what was decided about it, for `debrief`.
   * Collected here because it exists nowhere else: these messages are not in
   * `recent_messages` (history was read before the session began) and the
   * verdicts live only in the trace.
   */
  const arrivals: { author: string; text: string; verdict: string }[] = [];

  const budget = createBudget(
    {
      maxWallclockMs: config.session.max_wallclock_ms,
      maxModelCalls: config.session.max_model_calls,
      maxToolCalls: config.session.max_tool_calls,
    },
    startedAt,
  );

  // Settled in code, not by the model. See `core/mentions.ts`.
  const mention = message ? detectMention(message.text, config.agent) : undefined;
  let participationTrace: Record<string, unknown> | undefined;

  // Only worth asking when the agent was not named: being named already settles
  // the decision, and this call exists to inform that decision. A maintenance
  // session is replying to nothing, so there is no target to resolve.
  const replyTarget =
    message && config.session.reply_target && mention === undefined
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
  /** Set by `reflect` when the previous session answered the wrong question. */
  let requestCorrection = "";

  // In an ordinary session `reflect` loads these as a side effect of appending
  // to them. A maintenance session does not run `reflect`, so without this the
  // `impression` step would synthesise a summary from an empty list — the exact
  // work it exists to do, done over nothing.
  if (maintenance) {
    impressions = readImpressions(knowledgeDb(), identity.id).map((c) => ({ text: c.text }));
  }

  /**
   * The entry `compact` is working on. Chosen here, once, so the step and the
   * write that follows it cannot disagree about which entry was meant.
   *
   * One per session — the most-appended. Compaction is the first thing that
   * rewrites what the agent knows, so a bad pass touches one topic, and a store
   * that has fallen behind catches up over several quiet periods.
   */
  let compactionTarget: { id: number; topic: string; blocks: ContentBlock[] } | undefined;
  if (maintenance && queue.some((q) => q.name === "compact")) {
    const [best] = compactionCandidates(knowledgeDb(), KNOWLEDGE);
    if (best) {
      compactionTarget = { id: best.entry.id, topic: best.entry.topic, blocks: best.blocks };
      for (const item of queue) {
        if (item.name === "compact") item.topic = best.entry.topic;
      }
    } else {
      // Nothing qualifies. Dropped rather than run on nothing, which would spend
      // a digest call to summarise an empty list.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]?.name === "compact") queue.splice(i, 1);
      }
    }
  }

  // One guard, after every path that can add to or remove from the starting
  // queue. The closing steps are appended from *inside* the loop, so a session
  // that starts empty runs nothing and seals nothing — a session directory with
  // no record in it, indistinguishable from a session that never ran. Two
  // separate routes reach that state: every configured maintenance step being
  // refused, and the only step queued having no work to do.
  if (queue.length === 0) {
    closingQueued = true;
    queue.push({ name: "summarize", topic: "" });
  }

  const blockInput = (): BlockInput => ({
    message,
    history,
    identity,
    completed,
    prior,
    impressions,
    requestCorrection,
    arrivals,
    ...(compactionTarget
      ? { compactionTarget: { topic: compactionTarget.topic, blocks: compactionTarget.blocks } }
      : {}),
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
      budget,
    };

    // Being named settles whether to reply, full stop — `react` answers only
    // that question now, so there is nothing left for it to decide and no model
    // call to make. Structuring still happens, in `schedule`.
    const isEntry = step.name === config.session.entry_step;

    // The supervisor runs *alongside* the step rather than before it, so the
    // step never stalls waiting to be told whether to keep going. Both models
    // are resident, so this costs contention rather than a swap.
    const pending = (opts.pending?.() ?? []).filter((m) => !judged.has(m.id));
    const cancel = new AbortController();
    const supervised = pending.length > 0 && !isEntry;
    if (supervised) for (const m of pending) judged.add(m.id);

    const stepRun =
      isEntry && mention !== undefined
        ? sealDirectReaction(step, mention, ctx)
        : executeStep(step, next.topic, { ...ctx, signal: cancel.signal });

    const updateRun = supervised
      ? runUpdate({
          config,
          stepName: step.name,
          topic: next.topic,
          pending,
          promptsDir: opts.promptsDir,
        }).then((verdict) => {
          // Cancel at the next tool-call boundary rather than letting a doomed
          // step run to completion.
          if (verdict.verdict === "abort" || verdict.verdict === "respond_now") cancel.abort();
          return verdict;
        })
      : undefined;

    // The join point: verdicts are applied here and nowhere else, so a verdict
    // that arrives about a step state which has already advanced is still safe.
    const [settled, update] = await Promise.allSettled([stepRun, updateRun]);

    if (settled.status === "rejected") {
      // Cancelled mid-flight leaves the partial working file, which is the
      // point of streaming to it. Close the session out rather than failing it.
      if (!cancel.signal.aborted) {
        // Before it propagates: record *why*, in the session. Until now a dead
        // step left a partial file with no meta.json and the reason existed only
        // in the daemon's console, so a failed session could not be diagnosed
        // from its own directory — in a system whose first rule is trace
        // everything.
        await sealFailure(session, step.name, next.topic, settled.reason);
        throw settled.reason;
      }
      console.warn(`[session ${session.id}] ${step.name} cancelled by the supervisor.`);
      queue.length = 0;
      if (!closingQueued) {
        closingQueued = true;
        for (const name of config.session.closing_steps) queue.push({ name, topic: "" });
      }
      continue;
    }

    const outcome = settled.value;
    const verdict: UpdateVerdict | undefined =
      update.status === "fulfilled" ? update.value?.verdict : undefined;
    // Deferral is what the inbox does anyway; recording it is the whole
    // implementation, so an owed answer is visible rather than merely queued.
    if (verdict === "defer_to_session") {
      for (const m of pending) {
        deferred.push({ id: m.id, text: m.text });
        // Explicitly *not* consumed: deferral's whole meaning is that this one
        // gets a session to itself. Now that consumption is the default, the
        // verdict finally names a distinct action — which is what it lacked
        // when it measured 0/3 against `continue`.
        consumedIds.delete(m.id);
      }
    } else if (supervised) {
      for (const m of pending) consumedIds.add(m.id);
    }

    // Recorded whatever the verdict, including `continue`: a message the session
    // decided to carry on past is exactly the one most likely to end up
    // unanswered, and `debrief` cannot check what it cannot see.
    if (supervised) {
      for (const m of pending) {
        arrivals.push({ author: m.authorName, text: m.text, verdict: verdict ?? "continue" });
      }
    }

    if (verdict && verdict !== "continue") {
      supervisorVerdicts.push({ step: step.name, verdict });
      console.warn(`[session ${session.id}] supervisor: ${verdict} during ${step.name}`);
    }

    completed.push(outcome.completed);

    // `respond_now` cuts the remaining work and goes straight to the reply.
    if (verdict === "respond_now" && reply === undefined) {
      queue.length = 0;
      queue.push({ name: config.session.respond_step, topic: "" });
    }

    // `adjust` re-schedules the rest of the session in light of what is done.
    // Once per session: repeated re-planning is its own failure mode, and the
    // sealed output file is written once by design.
    if (verdict === "adjust" && !adjusted && reply === undefined) {
      adjusted = true;
      queue.unshift({ name: "adjust", topic: "" });
    }

    if (step.name === "adjust") {
      const revised = outcome.value as Adjustment;
      queue.length = 0;
      for (const item of revised.steps) queue.push({ name: item.step, topic: item.topic });
      queue.push({ name: config.session.respond_step, topic: "" });
    }

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
            directFollowup:
              computeSituation(message?.text ?? "", history, config.agent).distance === "immediate",
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
        // Everything downstream needs the task, not the wording. Queued here
        // rather than at session start so it stays off the declining path,
        // which is the common one; skipped without history, since a first
        // message in a channel is already self-contained.
        if (config.session.restate_step !== "" && history.length > 0) {
          queue.push({ name: config.session.restate_step, topic: "" });
        }

        // Structuring is a separate question, and only worth asking when there
        // is something to choose between.
        queue.push(
          config.session.selectable_steps.length > 0
            ? { name: config.session.schedule_step, topic: "" }
            : { name: config.session.respond_step, topic: "" },
        );
      }
    }

    if (step.name === config.session.schedule_step) {
      const chosen = outcome.value as Schedule;
      for (const item of chosen.steps) {
        queue.push({ name: item.step, topic: item.topic });
      }
      queue.push({ name: config.session.respond_step, topic: "" });
    }

    if (step.name === config.session.respond_step) {
      reply = (outcome.value as StepResponse).message;
      // Hand it over now. The closing steps are retrospection and run behind it.
      await opts.onReply?.(reply);
    }

    // `reflect` forms the impression, because it is the step that reads how
    // *they* reacted; `review` judges the agent's own work. The harness records
    // it — reflect runs on `digest` with tools refused and cannot write.
    if (step.name === config.session.reflect_step) {
      const { impression: noticed, correction } = outcome.value as Reflection;

      // Reaches `restate` through the `request_correction` block. Sealed output
      // is immutable, so this never rewrites the previous session's
      // `request.md` — it is a new reading that supersedes it for this session.
      requestCorrection = correction.trim();

      if (noticed.trim() !== "") {
        appendImpression(knowledgeDb(), identity.id, identity.displayName, noticed, {
          session: session.id,
          step: config.session.reflect_step,
        });
        impressions = readImpressions(knowledgeDb(), identity.id).map((c) => ({ text: c.text }));

        // With maintenance sessions available this belongs in idle time: it is
        // retrospective, it costs a digest call, and the fresh summary is for
        // the *next* session anyway, so nobody gains by paying for it while
        // somebody waits. Kept on the session tail when maintenance is off, so
        // turning the feature off never silently stops synthesis.
        const total = impressionCount(knowledgeDb(), identity.id);
        synthesiseImpression =
          !config.session.maintenance.enabled &&
          total > 0 &&
          total % config.session.impression_threshold === 0;
      }
    }

    // The only writer to stored knowledge outside the gatekeeper. It supersedes
    // rather than replaces: the blocks it was built from stay on disk, so a
    // compaction can always be checked against its evidence.
    if (step.name === "compact" && compactionTarget) {
      const { compacted } = outcome.value as Compaction;
      const applied = applyCompaction(knowledgeDb(), compactionTarget.id, compacted, {
        session: session.id,
        step: COMPACT_STEP,
      });
      if (!applied) {
        console.warn(
          `[session ${session.id}] compaction of "${compactionTarget.topic}" produced nothing; ` +
            `the entry was left as it was.`,
        );
      }
    }

    if (step.name === "impression") {
      const { summary } = outcome.value as Impression;
      if (summary.trim() !== "") {
        // The count is recorded with the summary so the next idle check can ask
        // "how many since?" rather than "how many in total?".
        await saveIdentity(paths, {
          ...identity,
          summary: summary.trim(),
          synthesisedAt: impressionCount(knowledgeDb(), identity.id),
        });
      }
    }

    // Closing steps go on once every other step has been queued, and are the
    // only thing left after a budget stop.
    const state = checkBudget(budget);
    if (!closingQueued && state.exhausted && queue.length > 0) {
      budgetStop = state.reason;
      console.warn(
        `[session ${session.id}] budget exhausted (${state.reason}); dropping ` +
          `${queue.length} remaining step(s).`,
      );
      // A promised reply still gets written, from whatever was gathered.
      const owed = reaction?.respond === true && reply === undefined;
      queue.length = 0;
      if (owed) queue.push({ name: config.session.respond_step, topic: "" });
    }

    if (queue.length === 0 && !closingQueued) {
      closingQueued = true;
      // `review` judges how well a reply served the person, so it has nothing to
      // judge here — and it has already been caught once describing a reply that
      // did not exist. `summarize` is computed and leaves the session directory
      // a record of what ran, which is the whole reason to keep it.
      for (const name of maintenance ? ["summarize"] : config.session.closing_steps) {
        queue.push({ name, topic: "" });
      }
      // Only when the session was actually interrupted. Most never are, and a
      // debrief of an uninterrupted session would be a digest call spent
      // confirming that nothing happened.
      if (arrivals.length > 0 && config.session.debrief_step !== "") {
        queue.push({ name: config.session.debrief_step, topic: "" });
      }
      if (synthesiseImpression) queue.push({ name: "impression", topic: "" });
    }
  }

  } finally {
    db?.close();
  }

  // Only an exchange becomes the session `reflect` reflects on. A maintenance
  // run has no exchange in it, and letting one claim the pointer would have the
  // next real session reflecting on a housekeeping pass — asking how the last
  // answer landed when there was no last answer.
  if (!maintenance) await recordLastSession(paths, channelId, session);

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
    ...(budgetStop !== undefined ? { budgetStop } : {}),
    ...(supervisorVerdicts.length > 0 ? { supervisorVerdicts } : {}),
    ...(deferred.length > 0 ? { deferred } : {}),
    // Deferred arrivals are deliberately excluded: those are the ones that
    // *should* get their own session.
    ...(consumedIds.size > 0 ? { consumed: [...consumedIds] } : {}),
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
  budget: Budget;
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
  // A step must not be able to outlive the session that queued it.
  const timeoutMs = Math.max(1_000, Math.min(model.timeoutMs, remainingMs(ctx.budget)));
  const prepared = await prepareModelStep({
    step,
    config,
    blockInput: ctx.blockInput,
    mention: ctx.mention,
    replyTarget: ctx.replyTarget,
    topic,
    promptsDir: ctx.promptsDir,
    rng: ctx.rng,
    budgetRemaining: describeBudget(ctx.budget),
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
      timeoutMs,
      signal: ctx.signal,
    });
    ctx.budget.toolCalls += loop.calls.length;
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
      timeoutMs,
      signal: ctx.signal,
      onDelta: (chunk) => working.write(chunk),
    });
  } finally {
    working.end();
  }
  ctx.budget.modelCalls += result.trace.attempts.length;

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
 * Records a step that threw, in the session it killed.
 *
 * Sealed like any other output, so it is immutable and shows up beside the
 * step's partial working file. A session that died is now diagnosable from its
 * own directory rather than from whatever was on the operator's screen.
 */
async function sealFailure(
  session: SessionHandle,
  stepName: string,
  topic: string,
  cause: unknown,
): Promise<void> {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const stack = cause instanceof Error ? cause.stack : undefined;

  try {
    await sealStep(
      session,
      "failure.md",
      [
        "# Session failed",
        "",
        `**Step:** \`${stepName}\`${topic ? ` — ${topic}` : ""}`,
        `**At:** ${new Date().toISOString()}`,
        "",
        "## What went wrong",
        "",
        detail,
        "",
        "## Partial output",
        "",
        `Whatever the step had written is in \`trace/${stepName}.partial\`. A step`,
        "streams there as it goes, so a timeout usually leaves most of an answer.",
        ...(stack ? ["", "## Stack", "", "```", stack, "```"] : []),
      ].join("\n"),
    );
  } catch (writeFailure) {
    // Never let the recording of a failure replace the failure itself.
    console.error(`[session ${session.id}] could not record the failure: ${String(writeFailure)}`);
  }
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
