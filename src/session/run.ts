import { createWriteStream } from "node:fs";
import type { Config } from "../config/schema.ts";
import type { ReactionResolution } from "../adapters/types.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import type { ChannelMessage, CompletedStep, Identity, InboundMessage } from "../core/types.ts";
import { callModel } from "../model/call.ts";
import { hostFor, resolveStepModel } from "../model/roles.ts";
import { runToolLoop } from "../model/toolLoop.ts";
import { ModelTimeout } from "../model/transport.ts";
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
import { mentionPolicy } from "../core/mentionPolicy.ts";
import type { InitiativeTarget } from "../core/initiative.ts";
import { harvestWithTrace, type HarvestEvent } from "./harvest.ts";
import { loadThinking, writeThinking } from "../store/thinkingStore.ts";
import type { Pondering } from "../steps/ponder.ts";
import { chosen, type Initiative } from "../steps/initiate.ts";
import type { Outreach } from "../steps/outreach.ts";
import {
  closeCuriosity,
  openCuriosities,
  recordPursuit,
  type Curiosity,
} from "../knowledge/curiosity.ts";
import type { Pruned } from "../steps/prune.ts";
import { normaliseEmoji } from "../core/emoji.ts";
import { replyTargetKind, type Reading, type ReplyTargetKind } from "../steps/read.ts";
import { lastContribution, readRecent } from "../store/channelStore.ts";
import { latestFrom } from "../store/channelRegistry.ts";
import { loadPriorSession, recordLastSession, type PriorSession } from "../store/priorSession.ts";
import {
  loadPlan,
  snapshotArtifacts,
  writePlanRevision,
  type Plan,
} from "../store/planStore.ts";
import { progressBetween, type ProgressDelta } from "./continuation.ts";
import { prepareModelStep } from "./prepareStep.ts";
import { describeStep, describeToolUse } from "./progress.ts";
import { runUpdate, type UpdateVerdict } from "./update.ts";
import {
  checkBudget,
  createBudget,
  describeBudget,
  stepTimeoutMs,
  type Budget,
  type BudgetState,
} from "./budget.ts";
import { getStep } from "../steps/registry.ts";
import type { AnyStep, ModelStep } from "../steps/types.ts";
import type { ToolCallRecord, ToolContext } from "../tools/types.ts";
import { deriveVerdict, wantsReply, type Verdict } from "../steps/verdict.ts";
import type { Stance } from "../steps/stance.ts";
import type { Reflection } from "../steps/reflect.ts";
import type { Impression } from "../steps/impression.ts";
import type { Compaction } from "../steps/compact.ts";
import type { PlanRevision } from "../steps/plan.ts";
import { saveIdentity } from "../store/identityStore.ts";
import type { Adjustment } from "../steps/adjust.ts";
import type { Schedule } from "../steps/schedule.ts";
import type { Response as StepResponse } from "../steps/respond.ts";
import type { Paths } from "../store/paths.ts";
import type { StoredReaction } from "../store/reactionStore.ts";
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
  /** Reactions standing on the agent's own messages here. Read by `reflect`. */
  reactions?: readonly StoredReaction[] | undefined;
  promptsDir?: string | undefined;
  /** Overrides the stored prior session; injectable for tests. */
  prior?: PriorSession | undefined;
  /** Overrides the stored plan; injectable for tests. */
  plan?: Plan | undefined;
  /** Injectable so prompt-variant selection is deterministic under test. */
  rng?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Mark the triggering message instead of replying to it. Called when `react`
   * decides an acknowledgement is wanted and a written answer is not.
   *
   * Silence is the worst outcome in a one-to-one channel — indistinguishable
   * from the daemon being down — so "nothing to add" should still leave a
   * trace. The adapter may not support it, in which case nothing happens.
   */
  onAcknowledge?: ((messageId: string, emoji: string) => Promise<void>) | undefined;
  /**
   * Validates/sanitises an emoji name before the adapter sends it.
   *
   * Used to resolve typos and near-matches against the transport's available
   * reactions. When several names match well, this session re-runs the step
   * once with those candidates in context.
   */
  resolveReaction?: ((emoji: string) => Promise<ReactionResolution>) | undefined;
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
  /**
   * How long this session waited for the daemon-wide turn.
   *
   * Recorded rather than charged: the turn is acquired before `runSession` is
   * called, so the budget's `startedAt` already excludes it. Traced because
   * "why was that reply slow?" is otherwise unanswerable once one session can
   * sit behind another for minutes.
   */
  queuedMs?: number | undefined;
  /**
   * Channels the agent may consider speaking into unprompted, already filtered
   * by the countable gates in `core/initiative.ts`.
   *
   * Supplied by the daemon because it spans channels and this session is
   * anchored to one — the same reason `pending` is supplied rather than read.
   */
  initiativeTargets?: readonly InitiativeTarget[] | undefined;
  /**
   * Optional lazy loader for initiative targets.
   *
   * Used on message sessions so `schedule` can choose `initiate` without
   * paying the cross-channel target survey cost unless that step actually runs.
   */
  loadInitiativeTargets?: (() => Promise<readonly InitiativeTarget[]>) | undefined;
  /**
   * Cross-channel maintenance work planned in this idle batch.
   *
   * Present on maintenance sessions only. Used by maintenance steps that need
   * a global view while remaining channel-anchored for storage and history.
   */
  maintenanceBatch?:
    | readonly { channelId: string; steps: readonly string[]; reason: string }[]
    | undefined;
  /**
   * Narrates the session as it runs: which step started, and what it touched.
   *
   * A session is a sequence of steps each taking tens of seconds, and the only
   * thing it used to say was "thinking" — so a long wait and a stuck daemon
   * looked identical from outside. Presentation only; nothing reads it back.
   */
  onProgress?: ((note: string) => void) | undefined;
}

export interface SessionResult {
  session: SessionHandle;
  completed: CompletedStep[];
  /** The reply to send, absent when the agent chose not to respond. */
  reply?: string;
  /**
   * What the session decided about the arriving message, and why.
   *
   * `verdict` is derived rather than decoded, so `reason` is assembled from the
   * two entry steps: the daemon logs it when no reply goes out, and "why didn't
   * it answer me?" is otherwise unanswerable.
   */
  decision?: { verdict: Verdict; reason: string };
  /** Set when the budget cut the session short, with the reason. */
  budgetStop?: string;
  /** Non-`continue` supervisor verdicts, in the order they were applied. */
  supervisorVerdicts?: { step: string; verdict: UpdateVerdict }[];
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
  /** What a continuation iteration achieved. Counted, never judged. */
  progress?: ProgressDelta;
  /** The plan as it stands after this session, when one is still running. */
  plan?: Plan;
  /**
   * What the agent decided to say, unprompted, and to whom.
   *
   * Returned rather than sent: the targets are not this session's own channel,
   * `runSession` has no adapter, and the cooldowns span every target. The daemon
   * owns delivery and the record of when each was last written to.
   */
  initiatives?: { ref: string; kind: "channel" | "dm"; id: string; name: string; message: string }[];
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
  const continuation = trigger.kind === "continuation";
  /** Neither speaks to the channel on its own account. */
  const unattended = maintenance || continuation;

  const session = await createSession(paths);
  const completed: CompletedStep[] = [];

  // `reflect` needs a previous session in *this channel* to reflect on, so the
  // first session in a channel skips it rather than reflecting on nothing.
  const prior: PriorSession | undefined =
    opts.prior ?? (await loadPriorSession(paths, channelId));

  // The durable plan, if one is running here. Absent once fulfilled or
  // abandoned, so a closed plan stops reaching any step at all.
  let plan: Plan | undefined = opts.plan ?? (await loadPlan(paths, channelId));

  // Settled in code, not by the model. See `core/mentions.ts`. Computed before
  // the queue because it decides whether the queue contains `read` at all.
  const mention = message ? detectMention(message.text, config.agent) : undefined;

  // A maintenance session has nothing to react to and nobody waiting, so it
  // skips the entry steps entirely and runs a fixed queue. There is no decision
  // for a model to make about whether to reply: it may not.
  const queue: { name: string; topic: string }[] = continuation
    ? // Work, then revise the plan. The revision is what makes progress
      // countable: an iteration that closed nothing did not progress, whatever
      // it would have said about itself.
      [
        ...config.session.continuation.steps.map((name) => ({ name, topic: trigger.reason })),
        ...(config.session.plan_step ? [{ name: config.session.plan_step, topic: trigger.reason }] : []),
      ].filter((item) => item.name !== config.session.respond_step)
    : maintenance
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
        // **Both run, even when the agent was named.** They used to be skipped
        // on that path — being named settled the reply, so neither answer was
        // read. That is what produced the mention loop: two instances named
        // each other in messages that asked nothing, and with no reading and a
        // fabricated `interest` of 1, nothing could tell an acknowledgement
        // from a question, or knew the agent had nothing to add.
        //
        // The cost is two `fast` calls on the addressed path, which used to be
        // free. It buys an honest `wants` and an honest `interest`, and every
        // guard below rests on them.
        { name: config.session.read_step, topic: "" },
        { name: config.session.stance_step, topic: "" },
      ];

  let reading: Reading | undefined;
  let stance: Stance | undefined;
  let entryVerdict: Verdict | undefined;
  /** For acknowledgement messages, whether to also send a written reply. */
  let acknowledgeReply = false;
  /** Resolved from the reading, and the axis `core/situation.ts` routes on. */
  let replyTarget: ReplyTargetKind | undefined;
  let reply: string | undefined;
  let closingQueued = false;
  let synthesiseImpression = false;
  let budgetStop: string | undefined;
  const supervisorVerdicts: { step: string; verdict: UpdateVerdict }[] = [];
  let adjusted = false;
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

  let participationTrace: Record<string, unknown> | undefined;
  /** Open questions this session recorded, for the log and the trace. */
  let harvested = 0;
  let curiosityEvents: HarvestEvent[] = [];
  /**
   * Targets `initiate` chose, in order, and how far `outreach` has got through
   * them. The index pairs each composed message with the target it was for —
   * the step itself only ever sees one at a time.
   */
  const outreachQueue: { target: InitiativeTarget; intent: string }[] = [];
  let outreachIndex = 0;
  /** What the agent decided to say, and to whom. Delivered by the daemon. */
  const initiatives: SessionResult["initiatives"] = [];
  let initiativeTargets: readonly InitiativeTarget[] | undefined = opts.initiativeTargets;

  // Opened on demand and closed at session end. A daemon runs indefinitely, so
  // a handle left open per session is a handle leaked per session.
  let db: ReturnType<typeof openKnowledgeDb> | undefined;
  const knowledgeDb = () => (db ??= openKnowledgeDb(paths.knowledge));
  let impressions: { text: string }[] = [];
  /**
   * Open questions, for the steps that read them. Loaded in a maintenance
   * session only: on the reply path they are neither read nor relevant, and
   * loading them would put "things you have been meaning to look into" in front
   * of a step whose job is answering the person in front of it.
   */
  let curiosities: Curiosity[] = [];
  /** The agent's background thinking, cross-channel. Maintenance sessions only. */
  let thinking = (await loadThinking(paths))?.text;
  /** Set by `reflect` when the previous session answered the wrong question. */
  let requestCorrection = "";

  // In an ordinary session `reflect` loads these as a side effect of appending
  // to them. A maintenance session does not run `reflect`, so without this the
  // `impression` step would synthesise a summary from an empty list — the exact
  // work it exists to do, done over nothing.
  if (maintenance && config.session.curiosity.enabled) {
    curiosities = openCuriosities(knowledgeDb()).slice(0, config.session.curiosity.max_open);
    // A `prune` with nothing to read spends a digest call to close nothing.
    // Dropped exactly as `compact` and `impression` are.
    if (curiosities.length === 0) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]?.name === "prune") queue.splice(i, 1);
      }
    }
  }

  if (maintenance) {
    const allImpressions = readImpressions(knowledgeDb(), identity.id);
    const since = Math.max(0, identity.synthesisedAt ?? 0);
    // Only what has not been synthesised yet. Feeding the full historical log
    // every time made each synthesis re-process the same old material and kept
    // maintenance sessions seeing effectively the same payload forever.
    impressions = allImpressions.slice(since).map((c) => ({ text: c.text }));

    // Nothing to read across. Dropped rather than run on nothing, exactly as
    // `compact` is below — a digest call spent summarising an empty list, and
    // the summary it wrote would replace a real one with an admission of
    // ignorance. `pendingMaintenance` will not schedule this, but a trigger can
    // be constructed by hand, and `impression` declares the impressions as
    // mandatory context: the alternative to dropping it here is a failed step.
    if (impressions.length === 0) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i]?.name === "impression") queue.splice(i, 1);
      }
    }
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

  /**
   * The open question this session was started to work on, when it was started
   * for one. Recorded as pursued once the work is done — a `prune` that cannot
   * see something was already looked into will keep it open for ever.
   */
  const pursuing = trigger.kind === "maintenance" ? trigger.curiosity : undefined;

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

  /** The plan as it stood before this session touched it, for the delta. */
  const planBefore = plan;

  // Read once per session, before anything this session says is appended, so it
  // is genuinely the *previous* contribution rather than this session's own.
  const contribution = await lastContribution(paths, channelId);

  const blockInput = (): BlockInput => ({
    message,
    history,
    identity,
    completed,
    prior,
    lastContribution: contribution,
    impressions,
    curiosities,
    thinking,
    ...(initiativeTargets ? { initiativeTargets } : {}),
    requestCorrection,
    arrivals,
    plan,
    reactions: opts.reactions,
    maintenanceBatch: opts.maintenanceBatch,
    ...(compactionTarget
      ? { compactionTarget: { topic: compactionTarget.topic, blocks: compactionTarget.blocks } }
      : {}),
  });

  /**
   * The context for writing to one target, which is not this session's channel.
   *
   * A person gets what is known about *them* — their summary, so `user_summary`
   * resolves to the target rather than to whoever the session is anchored on. A
   * channel gets its own transcript, its own plan, and its own last restatement
   * of what it was doing, which is the most direct record of what it was about.
   */
  async function targetInput(target: InitiativeTarget): Promise<BlockInput> {
    const base = blockInput();
    if (target.kind === "dm") {
      // A DM the agent is opening has no shared transcript, so the last thing
      // they said *anywhere* is the only handle it has on what they were
      // thinking about — and it is what lets the message pick up a thread
      // rather than arrive from nowhere.
      const latest = await latestFrom(paths, target.id);
      return {
        ...base,
        message: undefined,
        history: [],
        prior: undefined,
        plan: undefined,
        ...(latest
          ? { latestMessage: { author: latest.author, text: latest.text, where: latest.where } }
          : {}),
        identity: {
          id: target.id,
          displayName: target.name,
          aliases: [],
          summary: target.summary ?? "",
        },
      };
    }

    const history = await readRecent(paths, target.id, 20);
    const last = history.at(-1);
    return {
      ...base,
      message: undefined,
      history,
      ...(last ? { latestMessage: { author: last.author, text: last.text } } : {}),
      prior: await loadPriorSession(paths, target.id),
      plan: await loadPlan(paths, target.id),
      // A channel target has no single person behind it, and the session's own
      // identity is somebody else entirely — blanked so `user_summary` omits
      // itself rather than describing the wrong person.
      identity: { ...base.identity, summary: "" },
    };
  }

  /**
   * Appends the closing steps, once and only once.
   *
   * Extracted because they are appended from *inside* the step loop, so every
   * path that leaves an iteration early has to remember to do it. Forgetting has
   * produced a session that ran and sealed nothing three times already — and
   * nearly a fourth, when a timed-out step learned to carry on and skipped
   * straight past the block.
   */
  function queueClosingSteps(): void {
    if (closingQueued) return;
    closingQueued = true;
    // `review` judges how well a reply served the person, so it has nothing to
    // judge in an unattended session — and it has already been caught once
    // describing a reply that did not exist. `summarize` is computed and leaves
    // the session directory a record of what ran, which is the reason to keep it.
    for (const name of unattended ? ["summarize"] : config.session.closing_steps) {
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

  const reactionFrom = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const raw = (value as Record<string, unknown>)["reaction"];
    return typeof raw === "string" ? raw : undefined;
  };

  const reactionRetryContext = (candidates: readonly string[]): string =>
    [
      "## Reaction validation",
      "",
      "The previous reaction name was not an exact match for available reactions.",
      "Choose `reaction` exactly from this list:",
      ...candidates.map((name) => `- :${name}:`),
      "",
      "Keep the same judgement for the other fields; this rerun is only to pick a valid reaction name.",
    ].join("\n");

  async function rerunReactionChoice(
    stepName: string,
    topic: string,
    candidates: readonly string[],
  ): Promise<string | undefined> {
    const step = getStep(stepName);
    if (step.kind !== "model") return undefined;

    const model = resolveStepModel(config, step.name, step.defaultRole, step.defaultTools);
    const timeoutMs = stepTimeoutMs(
      budget,
      model.timeoutMs,
      config.session.selectable_steps.includes(step.name),
    );

    const prepared = await prepareModelStep({
      step,
      config,
      blockInput: blockInput(),
      mention,
      replyTarget,
      topic,
      promptsDir: opts.promptsDir,
      rng: opts.rng,
      budgetRemaining: describeBudget(budget),
      mentionPolicy: mentionPolicy(stance?.interest, config.session.min_interest).text,
    });

    const prompt = `${prepared.renderedPrompt}\n\n${reactionRetryContext(candidates)}`;
    const startedAtIso = new Date().toISOString();
    const started = Date.now();
    const result = await callModel({
      label: `${step.name}.reaction_retry`,
      host: hostFor(config, model.role),
      role: model.role,
      prompt,
      schema: step.buildSchema(config, blockInput()),
      fallback: () => step.fallback(config),
      timeoutMs,
      signal: opts.signal,
    });

    budget.modelCalls += result.trace.attempts.length;
    budget.waitedMs += result.trace.waitedMs;

    await writeStepTrace(session, {
      step: `${step.name}_reaction_retry`,
      topic,
      startedAt: startedAtIso,
      durationMs: Date.now() - started,
      variantId: prepared.prompt.variantId,
      promptPath: prepared.prompt.path,
      situation: prepared.situation?.id ?? prepared.fragmentId,
      situationVariantId: prepared.fragment?.variantId,
      mentionsOther: prepared.situation?.mentionsOther,
      renderedPrompt: prompt,
      rawResponse: result.raw,
      parsed: result.value,
      call: result.trace,
      contextBlocks: prepared.context.blocks,
    });

    return reactionFrom(result.value);
  }

  async function resolveReactionForSend(
    stepName: string,
    topic: string,
    proposed: string,
  ): Promise<string> {
    if (!opts.resolveReaction) return proposed;

    const first = await opts.resolveReaction(proposed);
    if (first.kind === "exact" || first.kind === "fuzzy") return first.emoji;
    if (first.kind === "invalid" || first.kind === "none" || first.kind === "unverified") {
      return first.emoji;
    }

    if (first.candidates.length === 0) return proposed;
    if (first.candidates.length === 1) return first.candidates[0]!;

    const retried = await rerunReactionChoice(stepName, topic, first.candidates);
    const picked = normaliseEmoji(retried) ?? first.candidates[0]!;
    const second = await opts.resolveReaction(picked);

    if (second.kind === "exact" || second.kind === "fuzzy") return second.emoji;
    if (second.kind === "ambiguous") return second.candidates[0] ?? picked;
    return second.emoji;
  }

  try {
  while (queue.length > 0) {
    const next = queue.shift() as { name: string; topic: string };
    const step = getStep(next.name);

    // `schedule` may choose `initiate` in a normal message session. Those
    // sessions do not always carry cross-channel targets up front, so load them
    // only if this step actually runs.
    if (step.name === "initiate" && initiativeTargets === undefined && opts.loadInitiativeTargets) {
      initiativeTargets = await opts.loadInitiativeTargets();
    }

    // **An `outreach` sees its own target, not the session's channel.** The
    // session is anchored wherever the sweep fired; the message is going
    // somewhere else. Writing to #importer out of a session anchored on #deploys
    // would put the wrong transcript, the wrong plan, and the wrong person's
    // summary in front of the step composing it.
    const forOutreach =
      step.name === "outreach" ? outreachQueue[outreachIndex] : undefined;

    const ctx = {
      ...opts,
      session,
      startedAt,
      completed,
      blockInput: forOutreach ? await targetInput(forOutreach.target) : blockInput(),
      ...(forOutreach
        ? {
            target: forOutreach.target.name,
            otherTargets: outreachQueue
              .filter((o) => o.target.ref !== forOutreach.target.ref)
              .map((o) => o.target.name),
          }
        : {}),
      mention,
      replyTarget,
      // Settled once `stance` has run, and read only by `respond` and `draft`,
      // both of which run after it.
      mentionPolicy: mentionPolicy(stance?.interest, config.session.min_interest).text,
      budget,
    };

    // Being named settles whether to reply, full stop. `stance` only measures
    // how much the agent has to add, and that feeds nothing but the
    // participation draw, which a named message skips — so there is nothing
    // left to decide and no model call to make. Structuring still happens, in
    // `schedule`.
    const isEntry =
      step.name === config.session.read_step || step.name === config.session.stance_step;

    // The supervisor runs *alongside* the step rather than before it, so the
    // step never stalls waiting to be told whether to keep going. Both models
    // are resident, so this costs contention rather than a swap.
    const pending = (opts.pending?.() ?? []).filter((m) => !judged.has(m.id));
    const cancel = new AbortController();
    const supervised = pending.length > 0 && !isEntry;
    if (supervised) for (const m of pending) judged.add(m.id);

    opts.onProgress?.(`${describeStep(step.name)} - ${next.topic || "unspecified"}`);

    const stepRun = executeStep(step, next.topic, { ...ctx, signal: cancel.signal });

    if (supervised) opts.onProgress?.(describeStep("update"));

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

    if (settled.status === "fulfilled") {
      const used = describeToolUse(settled.value.toolCalls ?? []);
      if (used) opts.onProgress?.(used);
    }

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

        // **A step that ran out of time does not end the session.** Its partial
        // output survives in the working file — which is the reason steps stream
        // to one — so the rest of the session can carry on from what it did
        // gather, and a reply that was promised still gets written. Killing the
        // whole session over one slow `research` threw away the answer somebody
        // was waiting for along with it.
        //
        // Only timeouts. Anything else — a transport failure, a bug — is not
        // something the next step can work around, and continuing would turn one
        // fault into a cascade of them, each sealing its own `failure.md`.
        if (isTimeout(settled.reason)) {
          const detail = settled.reason instanceof Error ? settled.reason.message : "timed out";
          console.warn(`[session ${session.id}] ${step.name} timed out; moving on. ${detail}`);
          opts.onProgress?.(`${describeStep(step.name)} ran out of time; carrying on`);
          // `schedule` runs before `respond` is queued. If it times out and a
          // reply is already owed, skipping straight to the closing steps turns
          // a pending answer into silence — exactly the failure mention
          // detection is meant to prevent.
          const owedReply =
            reply === undefined &&
            (entryVerdict === "reply" || (entryVerdict === "acknowledge" && acknowledgeReply));
          if (
            step.name === config.session.schedule_step &&
            owedReply &&
            !queue.some((item) => item.name === config.session.respond_step)
          ) {
            queue.push({ name: config.session.respond_step, topic: "" });
          }
          if (queue.length === 0) queueClosingSteps();
          continue;
        }
        throw settled.reason;
      }
      console.warn(`[session ${session.id}] ${step.name} cancelled by the supervisor.`);
      queue.length = 0;
      queueClosingSteps();
      continue;
    }

    const outcome = settled.value;
    const verdict: UpdateVerdict | undefined =
      update.status === "fulfilled" ? update.value?.verdict : undefined;
    // Deferral is what the inbox does anyway; recording it is the whole
    // implementation, so an owed answer is visible rather than merely queued.
    // Consumed only when the session *acted on* the arrival.
    //
    // `continue` means "this step is still the right step". It says nothing
    // about the message having been dealt with, so consuming on it silently
    // dropped anything unrelated — the message left the inbox and no session
    // ever answered it. Measured: `separate-matter` returns `continue` 3/3,
    // correctly, and under the old rule that lost the message.
    if (supervised && (verdict === "adjust" || verdict === "respond_now")) {
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

    // **The loose ends stop here rather than being discarded.** `research`,
    // `reason`, and `debrief` each report what they could not settle, and every
    // one of those reports used to be sealed, read by `respond` in the same
    // session, and never seen again — so the agent noticed what it did not know
    // and forgot within seconds. Copied out, never judged: which of them is
    // worth idle time is decided later, by how often it comes back.
    if (config.session.curiosity.enabled) {
      const result = await harvestWithTrace({
        db: knowledgeDb(),
        config,
        channelId,
        stepName: step.name,
        value: outcome.value,
        provenance: { session: session.id, step: step.name },
      });
      harvested += result.recorded;
      if (result.events.length > 0) curiosityEvents = curiosityEvents.concat(result.events);
    }

    // Recorded *before* the verdicts are applied, and that ordering is
    // load-bearing. Both `respond_now` and `adjust` are guarded on
    // `reply === undefined`, meaning "do not re-plan after the reply has gone
    // out" — but when the step that just finished *was* `respond`, setting the
    // reply afterwards left both guards reading a stale `undefined`. The
    // session then queued `respond` a second time, and because sealed output is
    // chmod 444 the second seal failed with EACCES rather than merely wasting a
    // call.
    if (step.name === config.session.respond_step) {
      reply = (outcome.value as StepResponse).message;
      // Handed over now: the closing steps are retrospection and run behind it.
      await opts.onReply?.(reply);
    }

    // `respond_now` cuts the remaining work and goes straight to the reply.
    if (verdict === "respond_now" && reply === undefined) {
      queue.length = 0;
      queue.push({ name: config.session.respond_step, topic: "" });
    }

    // `adjust` re-schedules the rest of the session in light of what is done.
    // Once per session: repeated re-planning is its own failure mode, and the
    // sealed output file is written once by design.
    // Skipped outright when there is nothing left to spend. Whether another
    // step fits is a *countable* fact, and this project's rule is that
    // countable facts are settled in code rather than handed to a model as a
    // judgement — the same reason mentions are matched rather than judged.
    // Measured: asked with an exhausted budget, `adjust` queues research anyway,
    // 0/3. Not asking is both cheaper and correct.
    if (verdict === "adjust" && !adjusted && reply === undefined) {
      adjusted = true;
      if (checkBudget(budget).exhausted) {
        console.warn(`[session ${session.id}] skipping adjust: no budget left to add steps.`);
      } else {
        queue.unshift({ name: "adjust", topic: "" });
      }
    }

    if (step.name === "adjust") {
      const revised = outcome.value as Adjustment;
      queue.length = 0;
      for (const item of revised.steps) queue.push({ name: item.step, topic: item.topic });
      queue.push({ name: config.session.respond_step, topic: "" });
    }

    // The objective half. Its only downstream use is routing: resolving the
    // decoded local id to a participant is what `core/situation.ts` picks a
    // fragment on, and `stance` is the step that reads that fragment.
    if (step.name === config.session.read_step) {
      reading = outcome.value as Reading;
      replyTarget = replyTargetKind(reading, history);

      // A provisional verdict, from the reading alone. `stance` overwrites it
      // moments later, so this matters in exactly one case: the budget running
      // out *between* the two entry steps. Without it, a session that had
      // already established an answer was wanted would end owing nothing,
      // because the verdict did not yet exist to be owed — the one regression
      // splitting `react` in two could introduce, and it is the case where
      // somebody is definitely waiting.
      //
      // Derived through the same function, with a neutral stance, rather than
      // by asking "did the reading want an answer?" here. A second copy of that
      // rule is how the two drift.
      entryVerdict = deriveVerdict({
        mentioned: mention !== undefined,
        reading,
        stance: { reason: "", interest: 0.5, reaction: config.session.acknowledge_emoji },
        minInterest: config.session.min_interest,
      });
    }

    if (step.name === config.session.stance_step) {
      stance = outcome.value as Stance;

      // Derived, never decoded — see `steps/verdict.ts`. Every fact this rests
      // on was established separately: named, by `core/mentions.ts`; what the
      // message wants and of whom, by `read`; what the agent has to add, by
      // `stance`.
      entryVerdict = deriveVerdict({
        mentioned: mention !== undefined,
        reading,
        stance,
        minInterest: config.session.min_interest,
      });

      // Weighted participation gates the "yes"; it can never turn a "no" into a
      // reply, and never silences a message that named the agent.
      const participation = config.session.participation;
      if (participation.enabled && entryVerdict === "reply") {
        const decision = responseProbability(
          {
            history,
            mentioned: mention !== undefined,
            directFollowup:
              computeSituation(message?.text ?? "", history, config.agent).distance === "immediate",
            // Measured by `core/standing.ts` while `stance` was prepared, and
            // reused rather than recomputed. Having standing in a conversation
            // should make the agent likelier to take part in it, not only
            // likelier to conclude that it could.
            ownSubject: outcome.ownSubject,
            interest: stance.interest,
          },
          participation,
        );
        const drawn = drawParticipation(decision, opts.rng);
        participationTrace = { ...decision, draw: drawn.draw, spoke: drawn.speak };
        // Damped into silence. Recorded as `tangent` rather than a bare "no":
        // the entry steps judged the message worth answering and the draw
        // disagreed, which is a different thing from it not being ours.
        if (!drawn.speak) entryVerdict = "tangent";
      }

      // Acknowledgement can still carry a written reply when there is enough to
      // add. Interest decides that first, then participation may damp it in
      // the same way it damps ordinary interjections.
      if (entryVerdict === "acknowledge") {
        acknowledgeReply = stance.interest >= config.session.min_interest;
        if (participation.enabled && acknowledgeReply) {
          const decision = responseProbability(
            {
              history,
              mentioned: mention !== undefined,
              directFollowup:
                computeSituation(message?.text ?? "", history, config.agent).distance === "immediate",
              ownSubject: outcome.ownSubject,
              interest: stance.interest,
            },
            participation,
          );
          const drawn = drawParticipation(decision, opts.rng);
          // Keep the primary decision trace on the reply path only; this branch
          // uses the same draw to decide whether acknowledgement also gets text.
          acknowledgeReply = drawn.speak;
        }
      }

      // Marked rather than answered. Deliberately *not* gated on participation:
      // an emoji is not a message, it does not crowd a channel, and damping it
      // would leave the person with nothing at all — the outcome this exists to
      // avoid.
      if (
        entryVerdict === "acknowledge" &&
        message !== undefined &&
        config.session.acknowledge_emoji !== ""
      ) {
        // The agent's own choice, unconstrained — `[session.acknowledgements]`
        // suggests, it does not decide. `normaliseEmoji` checks only that the
        // name has the shape of one; whether it exists is Slack's answer to
        // give, and a bad guess costs a log line rather than a session.
        const requested = normaliseEmoji(stance.reaction) ?? config.session.acknowledge_emoji;
        const chosen = await resolveReactionForSend(step.name, next.topic, requested);
        if (chosen !== "") await opts.onAcknowledge?.(message.id, chosen);
      }

      if (wantsReply(entryVerdict)) {
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
      } else if (entryVerdict === "acknowledge") {
        // Acknowledgements always get marked, and may also get a written reply
        // based on interest/participation. Scheduling still runs when enabled
        // so optional preparatory steps can be chosen for that reply.
        if (config.session.selectable_steps.length > 0) {
          if (config.session.restate_step !== "" && history.length > 0) {
            queue.push({ name: config.session.restate_step, topic: "" });
          }
          queue.push({ name: config.session.schedule_step, topic: "" });
        } else if (acknowledgeReply) {
          queue.push({ name: config.session.respond_step, topic: "" });
        }
      }
    }

    // **One `outreach` per target, queued rather than composed here.** Writing
    // four messages in one constrained decode produces four variations on one
    // paragraph; writing them separately produces four messages. Each is told
    // who else is being written to, so it does not repeat itself across people
    // or treat as private something it is about to say elsewhere.
    if (step.name === "initiate") {
      const picked = chosen(outcome.value as Initiative);
      for (const { target, intent } of picked) {
        const found = (initiativeTargets ?? []).find((t) => t.ref === target);
        if (!found) continue;
        outreachQueue.push({ target: found, intent });
      }
      // Queued at the front of what remains so they run before the closing
      // steps, and in the order they were chosen.
      queue.unshift(...outreachQueue.map(({ intent }) => ({ name: "outreach", topic: intent })));
    }

    if (step.name === "outreach") {
      const written = (outcome.value as Outreach).message.trim();
      const forTarget = outreachQueue[outreachIndex++];
      if (written !== "" && forTarget) {
        initiatives.push({
          ref: forTarget.target.ref,
          kind: forTarget.target.kind,
          id: forTarget.target.id,
          name: forTarget.target.name,
          message: written,
        });
      }
    }

    if (step.name === config.session.schedule_step) {
      const chosen = outcome.value as Schedule;
      const shouldReply =
        entryVerdict === "acknowledge" ? acknowledgeReply : true;

      // **Marked before the work, not after it.** Scheduling any step is the
      // moment the reply stops being immediate: `research` and `reason` run on
      // the large weights for tens of seconds to minutes, and the person saw
      // nothing at all in that window — indistinguishable, from outside, from
      // having been ignored. Sent here rather than queued as a step because it
      // is one API call and nobody should wait on it.
      //
      // Only when work was actually scheduled. A session that answers directly
      // is quick enough that marking it and then replying seconds later is
      // noise, not courtesy.
      if (chosen.steps.length > 0 && message !== undefined) {
        const requested = normaliseEmoji(chosen.reaction) ?? config.session.working_emoji;
        const working = await resolveReactionForSend(step.name, next.topic, requested);
        if (working !== "") {
          await opts.onAcknowledge?.(message.id, working).catch((cause) => {
            // A courtesy, and never worth a session. The adapter logs its own
            // failures; this catch is for an adapter that has none.
            console.warn(`[session ${session.id}] could not mark work in progress: ${String(cause)}`);
          });
        }
      }

      for (const item of chosen.steps) {
        queue.push({ name: item.step, topic: item.topic });
      }
      if (shouldReply) queue.push({ name: config.session.respond_step, topic: "" });
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

    // The only writer to the durable plan. No tool exposes plan writing, so a
    // step cannot revise one on its own authority — the same arrangement as
    // knowledge writes going through the gatekeeper.
    if (step.name === config.session.plan_step) {
      const revision = outcome.value as PlanRevision;
      if (revision.goal.trim() === "") {
        // The documented no-op: an unparsed revision must not close a plan or
        // invent a goal, so nothing is written and the existing plan stands.
        console.warn(`[session ${session.id}] plan revision had no goal; leaving the plan as it was.`);
      } else {
        // Measured after the work ran, so the recorded state is what the
        // iteration actually left behind rather than what it set out to do.
        const written = await writePlanRevision(paths, channelId, {
          status: revision.status,
          goal: revision.goal.trim(),
          outstanding: revision.outstanding,
          artifacts: revision.artifacts,
          artifactState: await snapshotArtifacts(paths.files, revision.artifacts),
          changed: revision.changed,
          session: session.id,
        });
        // Later steps in *this* session see the revision, not the plan it
        // replaced; a closed plan reads as absent immediately.
        plan = written.status === "active" ? written : undefined;

        // Finishing or abandoning is reported back to the channel that asked
        // for the work. Somebody who was told "I'll look into it" is owed the
        // outcome where they asked for it, and a plan that quietly dies is
        // worse than one that never started.
        //
        // `changed` is doing double duty on purpose: it is the record of what
        // this revision did *and* the text of the report. Computing the two
        // separately would be a way for them to disagree.
        if (continuation && written.status !== "active") {
          const verb = written.status === "fulfilled" ? "Finished" : "Dropping";
          await opts.onReply?.(
            `${verb}: ${written.goal}\n\n${written.changed.trim() || "(no detail recorded)"}`,
          );
        }
      }
    }

    // The only writer, the way `plan_step` is the only writer of plans. A tool
    // cannot revise this, so a step cannot rewrite what the agent thinks about
    // its own situation on its own authority.
    if (step.name === "ponder") {
      const { carry_forward } = outcome.value as Pondering;
      const written = await writeThinking(paths, carry_forward, session.id);
      thinking = written.text;
    }

    if (step.name === "prune") {
      // Applied here, never by the step. The same arrangement as knowledge
      // writes going through the gatekeeper and plans being written only by the
      // plan step: a step may say what should close, and the harness closes it.
      const { close } = outcome.value as Pruned;
      for (const { question, why } of close) {
        const match = curiosities.find((c) => c.question === question);
        if (match) closeCuriosity(knowledgeDb(), match.id, why);
      }
      if (close.length > 0) {
        opts.onProgress?.(`closed ${close.length} open question(s)`);
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
    //
    // Wallclock exhaustion drops ordinary optional work but keeps message-
    // emitting steps (`respond`, `initiate`, `outreach`) so communication can
    // still complete. Model/tool-call exhaustion remains a hard stop.
    const state = checkBudget(budget);
    if (!closingQueued && state.exhausted && queue.length > 0) {
      budgetStop = state.reason;
      // A promised reply still gets written, from whatever was gathered.
      const owed = entryVerdict !== undefined && wantsReply(entryVerdict) && reply === undefined;
      const keep = isWallclockExhausted(state)
        ? queue.filter((item) => isWallclockExemptStep(item.name, config))
        : [];
      const dropped = queue.length - keep.length;
      queue.length = 0;
      queue.push(...keep);
      if (owed && !queue.some((item) => item.name === config.session.respond_step)) {
        queue.push({ name: config.session.respond_step, topic: "" });
      }
      console.warn(
        `[session ${session.id}] budget exhausted (${state.reason}); dropping ` +
          `${dropped} remaining step(s), keeping ${queue.length}.`,
      );
    }

    if (queue.length === 0) queueClosingSteps();
  }

  } finally {
    db?.close();
  }

  // Only an exchange becomes the session `reflect` reflects on. A maintenance
  // run has no exchange in it, and letting one claim the pointer would have the
  // next real session reflecting on a housekeeping pass — asking how the last
  // answer landed when there was no last answer.
  // Only an exchange becomes the session `reflect` reflects on. Neither a
  // maintenance run nor a continuation has one in it, and letting either claim
  // the pointer would have the next real session asking how the last answer
  // landed when there was no answer.
  if (!unattended) await recordLastSession(paths, channelId, session);

  // **What was tried, recorded against the question it was tried on.** Without
  // it a `prune` reading the store sees a question that has come up four times
  // and nothing saying anybody ever went and looked — so it keeps it open, and
  // the agent researches the same thing every quiet period for ever.
  if (pursuing) {
    const did = completed.map((c) => c.name).join(", ");
    recordPursuit(
      knowledgeDb(),
      pursuing.id,
      `Pursued in session ${session.id} (${did || "nothing ran"}).`,
      session.id,
    );
  }

  // One file answering "why did it, or didn't it, speak?" — the verdict, every
  // input the derivation rests on, and (below) the draw. Split across two
  // artifacts it could only be reconstructed by hand.
  if (entryVerdict !== undefined) {
    await writeParticipationTrace(session, {
      file: "decision",
      verdict: entryVerdict,
      mentioned: mention ?? null,
      ...(reading
        ? {
            replyTarget: replyTarget ?? null,
            targetId: reading.target,
            addressee: reading.addressee,
            wants: reading.wants,
            readingReason: reading.reason,
          }
        : { note: "The agent was named; the reading was skipped." }),
      interest: stance?.interest ?? null,
      reaction: stance?.reaction ?? null,
      stanceReason: stance?.reason ?? null,
    });
  }

  if (opts.queuedMs !== undefined && opts.queuedMs > 0) {
    await writeParticipationTrace(session, {
      file: "turn",
      queuedMs: opts.queuedMs,
      note: "Waited for the daemon-wide session turn. Excluded from the wallclock budget.",
    });
  }

  if (participationTrace) {
    await writeParticipationTrace(session, participationTrace);
  }

  if (config.session.curiosity.enabled) {
    await writeParticipationTrace(session, {
      file: "curiosity",
      harvested,
      observed: curiosityEvents.length,
      events: curiosityEvents,
      note:
        "Per-question harvest outcomes. Dropped/error entries make curiosity write failures auditable without querying sqlite.",
    });
  }

  return {
    session,
    completed,
    ...(budgetStop !== undefined ? { budgetStop } : {}),
    ...(supervisorVerdicts.length > 0 ? { supervisorVerdicts } : {}),
    ...(consumedIds.size > 0 ? { consumed: [...consumedIds] } : {}),
    ...(reply !== undefined ? { reply } : {}),
    ...(entryVerdict !== undefined
      ? {
          decision: {
            verdict: entryVerdict,
            reason: [reading?.reason, stance?.reason].filter(Boolean).join(" / ") || "no reason recorded",
          },
        }
      : {}),
    ...(continuation ? { progress: progressBetween(planBefore, plan) } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(initiatives.length > 0 ? { initiatives } : {}),
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
  /** Whether the reply may name anybody, from `stance`'s interest. */
  mentionPolicy?: string | undefined;
  /** Who an `outreach` is writing to, and who else is being written to. */
  target?: string | undefined;
  otherTargets?: readonly string[] | undefined;
  budget: Budget;
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
    files: ctx.paths.files,
    sessions: ctx.paths.sessions,
    session: ctx.session.id,
    step: stepName,
  };
}

/**
 * Whether a step died because it ran out of time rather than because something
 * is wrong. Only a timeout is worth carrying on from: the partial output is
 * usable, and the next step may not need what the dead one was fetching.
 */
const isTimeout = (cause: unknown): boolean =>
  cause instanceof ModelTimeout ||
  (cause instanceof Error && (cause.name === "TimeoutError" || /timed out/i.test(cause.message)));

/** Steps that still run at full timeout and survive wallclock budget exhaustion. */
const isWallclockExemptStep = (stepName: string, config: Config): boolean =>
  stepName === config.session.respond_step || stepName === "initiate" || stepName === "outreach";

const isWallclockExhausted = (state: BudgetState): boolean =>
  state.exhausted && (state.reason?.startsWith("wallclock ") ?? false);

interface StepOutcome {
  completed: CompletedStep;
  value: unknown;
  /** What the step's tool loop actually did, for the progress line. */
  toolCalls?: readonly ToolCallRecord[] | undefined;
  /**
   * Whether this message continues a subject the agent has spoken on, as
   * measured while preparing the step. Carried out here so the participation
   * draw can use it without a second embed call.
   */
  ownSubject?: boolean | undefined;
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
  const wallclockSelectable =
    config.session.selectable_steps.includes(step.name) && !isWallclockExemptStep(step.name, config);
  const timeoutMs = stepTimeoutMs(
    ctx.budget,
    model.timeoutMs,
    wallclockSelectable,
  );
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
    mentionPolicy: ctx.mentionPolicy,
    target: ctx.target,
    otherTargets: ctx.otherTargets,
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
      host: hostFor(config, model.role),
      role: model.role,
      prompt: renderedPrompt,
      tools: resolveTools(model.tools),
      context: toolContext(ctx, step.name),
      timeoutMs,
      signal: ctx.signal,
    });
    ctx.budget.toolCalls += loop.calls.length;
    // Queued time and actual tool execution are not model-runtime wallclock.
    // Excluding both keeps selectable-step clamps about model work, not I/O.
    ctx.budget.waitedMs += loop.waitedMs + loop.toolMs;
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
      host: hostFor(config, model.role),
      role: model.role,
      prompt: finalPrompt,
      schema: step.buildSchema(config, ctx.blockInput),
      fallback: () => step.fallback(config),
      timeoutMs,
      signal: ctx.signal,
      onDelta: (chunk) => working.write(chunk),
    });
  } finally {
    working.end();
  }
  ctx.budget.modelCalls += result.trace.attempts.length;
  // Queueing is not work. Without this a session behind a busy model would burn
  // its wallclock waiting and truncate itself before doing anything.
  ctx.budget.waitedMs += result.trace.waitedMs;

  const content = step.render(result.value);
  const sealed = await sealStep(session, step.outputFile, content);

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
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(prepared.standing ? { ownSubject: prepared.standing.related } : {}),
    completed: {
      name: step.name,
      topic,
      // The file actually written, not the one the step asked for: a step that
      // runs twice in a session gets `outreach.md` and `outreach_2.md`.
      outputFile: sealed.file,
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
  const sealed = await sealStep(ctx.session, step.outputFile, content);

  const durationMs = Date.now() - stepStarted;
  await writeStepTrace(ctx.session, { step: step.name, topic, startedAt: startedAtIso, durationMs });

  return {
    value: content,
    completed: { name: step.name, topic, outputFile: sealed.file, content, durationMs },
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
