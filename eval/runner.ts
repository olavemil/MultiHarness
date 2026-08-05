import { detectMention } from "../src/core/mentions.ts";
import type { ChannelMessage, CompletedStep, Identity, InboundMessage } from "../src/core/types.ts";
import type { Config } from "../src/config/schema.ts";
import { callModel } from "../src/model/call.ts";
import { resolveStepModel } from "../src/model/roles.ts";
import { prepareModelStep } from "../src/session/prepareStep.ts";
import { resolveReplyTarget } from "../src/session/replyTarget.ts";
import { getStep } from "../src/steps/registry.ts";
import type { ModelStep } from "../src/steps/types.ts";
import type { PriorSession } from "../src/store/priorSession.ts";

/**
 * Runs any registered step against a case.
 *
 * Written generically on purpose. A bespoke runner per step meant every new
 * step arrived unmeasured until someone wrote one, and the three that existed
 * had each drifted from the live path in a different way. There is one
 * definition of "run a step for evaluation" here, and it uses the same
 * `prepareModelStep` a session does.
 */

export interface CaseMessage {
  from: string;
  text: string;
}

export interface EvalCase {
  id: string;
  note?: string;
  history?: CaseMessage[];
  message?: CaseMessage;
  /**
   * Sealed output of the previous session, for steps that read it. `request` is
   * how that session understood the question — the artifact `reflect` checks
   * against how the person then reacted.
   */
  prior?: { review: string; summary: string; reflection: string; request?: string; debrief?: string };
  /**
   * A correction `reflect` produced earlier in this session, as `restate` sees
   * it. Empty in almost every case, which is the point.
   */
  request_correction?: string;
  /** Output of earlier steps in *this* session, for steps that read it. */
  completed?: { name: string; topic?: string; content: string }[];
  /** Pre-existing knowledge entries, seeded with real embeddings. */
  store?: { topic: string; summary: string; seed: string }[];
  /** Impressions already recorded about the speaker. */
  impressions?: string[];
  /**
   * For `debrief`: what arrived while the session was working, and what the
   * supervisor decided about each. Without these the step has nothing to judge.
   */
  arrivals?: { author: string; text: string; verdict: string }[];
  /** The durable plan already running in this channel, as `current_plan`. */
  plan?: { goal: string; outstanding: string[]; artifacts?: string[] };
  /** For `compact`: the notes accumulated under one knowledge entry. */
  entry?: { topic: string; notes: { text: string; session?: string; step?: string }[] };
  /** For `update`: the step in flight and what it was given to do. */
  step_name?: string;
  step_topic?: string;
  /**
   * What the session has left, as steps see it. Defaults to a mid-session
   * figure rather than "unconstrained": `adjust` weighs its choices against
   * this, so an eval that omitted it would measure a prompt no session renders.
   */
  budget_remaining?: string;
  /** Which output field to judge. Defaults per step below. */
  field?: string;
  /** How to compare. Defaults to `equals`. */
  mode?: "equals" | "length" | "empty" | "nonempty" | "includes";
  expect?: unknown;
}

export interface StepAttempt {
  answer: unknown;
  reason: string;
  ms: number;
  fellBack: boolean;
  deterministic: boolean;
  detail: string;
  error?: string;
}

/** The field that carries a step's verdict, when a case does not say. */
const DEFAULT_FIELD: Record<string, string> = {
  react: "respond",
  reflect: "signal",
  restate: "resolved",
  schedule: "steps",
  research: "findings",
  reason: "conclusion",
  draft: "draft",
  respond: "message",
  review: "quality",
  impression: "summary",
  adjust: "steps",
  update: "verdict",
  debrief: "unanswered",
  compact: "compacted",
  plan: "status",
};

/** The field that explains it, shown when a case fails. */
const REASON_FIELD: Record<string, string> = {
  react: "reason",
  reflect: "assessment",
  restate: "request",
  schedule: "reason",
  research: "findings",
  reason: "thinking",
  draft: "notes",
  respond: "message",
  review: "assessment",
  impression: "reading",
  adjust: "reason",
  update: "reason",
  debrief: "assessment",
  compact: "reasoning",
  plan: "reasoning",
};

export function buildInput(testCase: EvalCase, index = 0) {
  const history: ChannelMessage[] = (testCase.history ?? []).map((m, i) => ({
    id: `h${i}`,
    identityId: m.from === "agent" ? "agent" : m.from,
    author: m.from === "agent" ? "agent" : m.from,
    text: m.text,
    at: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
    fromAgent: m.from === "agent",
  }));

  const from = testCase.message?.from ?? "olav";
  const message: InboundMessage = {
    id: `incoming-${index}`,
    channelId: "eval",
    identityId: from,
    authorName: from,
    text: testCase.message?.text ?? "",
    receivedAt: new Date().toISOString(),
  };

  const identity: Identity = { id: from, displayName: from, aliases: [], summary: "" };

  const completed: CompletedStep[] = (testCase.completed ?? []).map((c) => ({
    name: c.name,
    topic: c.topic ?? "",
    outputFile: `${c.name}.md`,
    content: c.content,
    durationMs: 0,
  }));

  const prior: PriorSession | undefined = testCase.prior
    ? { id: "000001-prior", number: 1, request: "", debrief: "", ...testCase.prior }
    : undefined;

  return {
    message,
    history,
    identity,
    completed,
    prior,
    impressions: (testCase.impressions ?? []).map((text) => ({ text })),
    requestCorrection: testCase.request_correction ?? "",
    arrivals: testCase.arrivals ?? [],
    ...(testCase.plan
      ? {
          plan: {
            revision: 0,
            status: "active" as const,
            goal: testCase.plan.goal,
            outstanding: testCase.plan.outstanding,
            artifacts: testCase.plan.artifacts ?? [],
            artifactState: [],
            changed: "",
            session: "000001",
            at: new Date().toISOString(),
          },
        }
      : {}),
    ...(testCase.entry
      ? {
          compactionTarget: {
            topic: testCase.entry.topic,
            blocks: testCase.entry.notes.map((n, i) => ({
              text: n.text,
              session: n.session ?? `00000${i + 1}`,
              step: n.step ?? "research",
              at: new Date(Date.now() - (10 - i) * 86_400_000).toISOString(),
            })),
          },
        }
      : {}),
  };
}

export interface RunStepOptions {
  think?: boolean | undefined;
  variant?: string | undefined;
}

export async function runStep(
  stepName: string,
  config: Config,
  testCase: EvalCase,
  opts: RunStepOptions = {},
): Promise<StepAttempt> {
  const step = getStep(stepName);
  if (step.kind !== "model") {
    throw new Error(`"${stepName}" is a computed step and has nothing to evaluate.`);
  }

  const blockInput = buildInput(testCase);
  const started = Date.now();
  const mention = detectMention(blockInput.message.text, config.agent);

  // Mirrors `session/run.ts`: being named settles whether to reply, so `react`
  // is never consulted for it. Nothing else is short-circuited.
  if (stepName === config.session.entry_step && mention !== undefined) {
    return {
      answer: true,
      reason: `named ("${mention}")`,
      ms: 0,
      fellBack: false,
      deterministic: true,
      detail: "deterministic",
    };
  }

  // Also mirrored: the reply target informs a decision that being named has
  // already settled, so it is not worth a call.
  const replyTarget =
    config.session.reply_target && stepName === config.session.entry_step && mention === undefined
      ? await resolveReplyTarget(config, blockInput)
      : undefined;

  const prepared = await prepareModelStep({
    step: step as ModelStep<unknown>,
    config,
    blockInput,
    mention,
    replyTarget: replyTarget?.kind,
    variant: opts.variant,
    topic: testCase.entry?.topic ?? testCase.step_topic ?? "",
    budgetRemaining:
      testCase.budget_remaining ??
      "About 300s of wallclock, 14 model calls, and 18 tool calls remain in this session.",
  });

  const model = resolveStepModel(config, step.name, step.defaultRole, step.defaultTools);
  const role = opts.think === undefined ? model.role : { ...model.role, think: opts.think };

  const result = await callModel({
    label: step.name,
    host: config.ollama.host,
    role,
    prompt: prepared.renderedPrompt,
    schema: (step as ModelStep<unknown>).buildSchema(config),
    fallback: () => (step as ModelStep<unknown>).fallback(config),
    timeoutMs: model.timeoutMs,
  });

  const value = result.value as Record<string, unknown>;
  const field = testCase.field ?? DEFAULT_FIELD[stepName] ?? "";
  const reasonField = REASON_FIELD[stepName] ?? "";

  return {
    answer: value[field],
    reason: String(value[reasonField] ?? ""),
    ms: Date.now() - started,
    fellBack: result.trace.fellBack,
    deterministic: false,
    detail:
      (prepared.situation?.id ?? prepared.fragmentId ?? prepared.prompt.variantId) +
      (replyTarget ? ` <-${replyTarget.kind}` : ""),
  };
}

/** Compares an attempt's answer against what the case expects. */
export function matches(testCase: EvalCase, answer: unknown): boolean {
  switch (testCase.mode ?? "equals") {
    case "length":
      return Array.isArray(answer) && answer.length === testCase.expect;
    case "empty":
      return Array.isArray(answer)
        ? answer.length === 0
        : String(answer ?? "").trim() === "";
    case "nonempty":
      return Array.isArray(answer)
        ? answer.length > 0
        : String(answer ?? "").trim() !== "";
    case "includes": {
      // Serialised so a chosen-steps array can be searched for a step name,
      // not only a plain string field.
      const haystack = typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
      return haystack.toLowerCase().includes(String(testCase.expect).toLowerCase());
    }
    default:
      return answer === testCase.expect;
  }
}

/** How the expectation reads in the report. */
export const describeExpectation = (testCase: EvalCase): string => {
  const field = testCase.field ?? "";
  switch (testCase.mode) {
    case "length":
      return `${field} has ${testCase.expect}`;
    case "empty":
      return `${field} empty`;
    case "nonempty":
      return `${field} non-empty`;
    case "includes":
      return `${field} mentions ${String(testCase.expect)}`;
    default:
      return String(testCase.expect);
  }
};
