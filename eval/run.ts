/**
 * Eval harness for the react decision.
 *
 * Two things it does that a single live run cannot:
 *
 * 1. **Replays history.** The same message is a different decision depending on
 *    who spoke last and who was named earlier. Context-free cases disagree with
 *    live behaviour, so cases carry their transcript.
 * 2. **Repeats each case.** phi4 has returned opposite readings of identical
 *    input on consecutive runs. A single sample cannot distinguish a real
 *    improvement from that noise, so every case is run N times and reported as
 *    a rate. UNSTABLE is a first-class outcome, not a rounding error.
 *
 * Prompt assembly comes from `prepareModelStep`, the same code a live session
 * uses — this harness never builds its own copy of the prompt.
 *
 *   node eval/run.ts [--step react|reflect] [--model <tag>] [--runs 5]
 *                     [--case <id>] [--variant react_2] [--think false]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { detectMention } from "../src/core/mentions.ts";
import type { ChannelMessage, Identity, InboundMessage } from "../src/core/types.ts";
import { callModel } from "../src/model/call.ts";
import { resolveStepModel } from "../src/model/roles.ts";
import { prepareModelStep } from "../src/session/prepareStep.ts";
import { resolveReplyTarget } from "../src/session/replyTarget.ts";
import { react, type Reaction } from "../src/steps/react.ts";
import { reflect, type Reflection } from "../src/steps/reflect.ts";
import type { PriorSession } from "../src/store/priorSession.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface CaseMessage {
  from: string;
  text: string;
}
interface EvalCase {
  id: string;
  note?: string;
  history: CaseMessage[];
  message: CaseMessage;
  /** Boolean for react's `respond`; a string for reflect's `signal`. */
  expect: boolean | string;
  /** Previous session output, for steps that read it. */
  prior?: { review: string; summary: string; reflection: string };
  /** Asserts the step invented no course-correction. */
  expectNoRecommendations?: boolean;
}

interface Attempt {
  answer: boolean | string;
  reason: string;
  ms: number;
  fellBack: boolean;
  deterministic: boolean;
  situation: string;
  error?: string;
  /** Recommendation count, for steps that emit them. */
  recommendations?: number;
}

type Verdict = "PASS" | "UNSTABLE" | "FAIL";

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    model: get("--model"),
    runs: Number(get("--runs") ?? 5),
    only: get("--case"),
    step: get("--step") ?? "react",
    variant: get("--variant"),
    think: get("--think") === undefined ? undefined : get("--think") !== "false",
  };
}

const toChannelMessage = (m: CaseMessage, i: number): ChannelMessage => ({
  id: `h${i}`,
  identityId: m.from === "agent" ? "agent" : m.from,
  author: m.from === "agent" ? "agent" : m.from,
  text: m.text,
  at: new Date(Date.now() - (100 - i) * 60_000).toISOString(),
  fromAgent: m.from === "agent",
});

interface RunOpts {
  think: boolean | undefined;
  variant: string | undefined;
}

function buildInput(testCase: EvalCase) {
  const history = testCase.history.map(toChannelMessage);
  const message: InboundMessage = {
    id: "incoming",
    channelId: "eval",
    identityId: testCase.message.from,
    authorName: testCase.message.from,
    text: testCase.message.text,
    receivedAt: new Date().toISOString(),
  };
  const identity: Identity = {
    id: testCase.message.from,
    displayName: testCase.message.from,
    aliases: [],
    summary: "",
  };

  const prior: PriorSession | undefined = testCase.prior
    ? { id: "000001-prior", number: 1, ...testCase.prior }
    : undefined;

  return { message, history, identity, completed: [] as never[], prior };
}

async function runReact(
  config: Config,
  testCase: EvalCase,
  opts: RunOpts,
): Promise<Attempt> {
  const blockInput = buildInput(testCase);
  const { message } = blockInput;
  const started = Date.now();
  const mention = detectMention(message.text, config.agent);

  // Mirrors the live fast path: being named settles the decision in code, and
  // with no selectable steps the model is never consulted.
  if (mention !== undefined && config.session.selectable_steps.length === 0) {
    return {
      answer: true,
      reason: `named ("${mention}")`,
      ms: Date.now() - started,
      fellBack: false,
      deterministic: true,
      situation: "—",
    };
  }

  const replyTarget = config.session.reply_target
    ? await resolveReplyTarget(config, blockInput)
    : undefined;
  const prepared = await prepareModelStep({
    step: react,
    config,
    blockInput,
    mention,
    replyTarget: replyTarget?.kind,
    variant: opts.variant,
  });
  const model = resolveStepModel(config, react.name, react.defaultRole);
  const role = opts.think === undefined ? model.role : { ...model.role, think: opts.think };

  const result = await callModel({
    label: "react",
    host: config.ollama.host,
    role,
    prompt: prepared.renderedPrompt,
    schema: react.buildSchema(config),
    fallback: () => react.fallback(config),
    timeoutMs: model.timeoutMs,
  });

  const value = result.value as Reaction;
  return {
    answer: value.respond,
    reason: value.reason,
    ms: Date.now() - started,
    fellBack: result.trace.fellBack,
    deterministic: false,
    situation:
      (prepared.situation?.id ?? "—") + (replyTarget ? ` <-${replyTarget.kind}` : ""),
  };
}

async function runReflect(
  config: Config,
  testCase: EvalCase,
  opts: RunOpts,
): Promise<Attempt> {
  const blockInput = buildInput(testCase);
  const started = Date.now();

  const prepared = await prepareModelStep({
    step: reflect,
    config,
    blockInput,
    mention: undefined,
    variant: opts.variant,
  });
  const model = resolveStepModel(config, reflect.name, reflect.defaultRole);
  const role = opts.think === undefined ? model.role : { ...model.role, think: opts.think };

  const result = await callModel({
    label: "reflect",
    host: config.ollama.host,
    role,
    prompt: prepared.renderedPrompt,
    schema: reflect.buildSchema(config),
    fallback: () => reflect.fallback(config),
    timeoutMs: model.timeoutMs,
  });

  const value = result.value as Reflection;
  return {
    answer: value.signal,
    reason: value.assessment,
    ms: Date.now() - started,
    fellBack: result.trace.fellBack,
    deterministic: false,
    situation: prepared.prompt.variantId,
    recommendations: value.recommendations.length,
  };
}

const RUNNERS: Record<string, (c: Config, t: EvalCase, o: RunOpts) => Promise<Attempt>> = {
  react: runReact,
  reflect: runReflect,
};

function verdictFor(attempts: Attempt[], expect: boolean | string): Verdict {
  // An errored attempt is never correct. It carries `respond: false`, which
  // would otherwise be scored as a right answer on every negative case and
  // quietly inflate the suite — a timeout was passing `other-thread-absent`.
  const correct = attempts.filter((a) => !a.error && a.answer === expect).length;
  if (correct === attempts.length) return "PASS";
  return correct === 0 ? "FAIL" : "UNSTABLE";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = await loadConfig();
  const config: Config = args.model
    ? { ...base, roles: { ...base.roles, fast: { ...base.roles["fast"]!, model: args.model } } }
    : base;

  const runner = RUNNERS[args.step];
  if (!runner) throw new Error(`Unknown step "${args.step}". Known: ${Object.keys(RUNNERS).join(", ")}.`);

  const file = path.join(HERE, "cases", `${args.step}.json`);
  const suite = JSON.parse(await readFile(file, "utf8")) as { cases: EvalCase[] };
  const cases = args.only ? suite.cases.filter((c) => c.id === args.only) : suite.cases;

  const step = args.step === "reflect" ? reflect : react;
  const modelName = resolveStepModel(config, step.name, step.defaultRole).role.model;
  console.log(
    `\n${args.step} eval — ${modelName}, ${args.runs} run(s) per case` +
      `${args.variant ? `, variant ${args.variant}` : ""}\n`,
  );

  const verdicts: Verdict[] = [];
  let totalMs = 0;
  let modelCalls = 0;

  for (const testCase of cases) {
    const attempts: Attempt[] = [];
    for (let i = 0; i < args.runs; i++) {
      try {
        attempts.push(await runner(config, testCase, { think: args.think, variant: args.variant }));
      } catch (cause) {
        // One model failure must not abort the suite — a timeout is a result.
        attempts.push({
          answer: "__error__",
          reason: cause instanceof Error ? cause.message : String(cause),
          ms: 0,
          fellBack: false,
          deterministic: false,
          situation: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    const verdict = verdictFor(attempts, testCase.expect);
    verdicts.push(verdict);

    const correct = attempts.filter((a) => !a.error && a.answer === testCase.expect).length;
    const avgMs = Math.round(attempts.reduce((n, a) => n + a.ms, 0) / attempts.length);
    totalMs += attempts.reduce((n, a) => n + a.ms, 0);
    modelCalls += attempts.filter((a) => !a.deterministic).length;

    const marker = { PASS: "  ok  ", UNSTABLE: " FLAKY", FAIL: " FAIL " }[verdict];
    const detail = attempts[0]?.deterministic ? "deterministic" : attempts[0]?.situation ?? "—";
    const fellBack = attempts.filter((a) => a.fellBack).length;
    const errored = attempts.filter((a) => a.error).length;

    console.log(
      `${marker} ${testCase.id.padEnd(24)} ${correct}/${attempts.length} ` +
        `(want ${String(testCase.expect)})  ${detail.padEnd(22)} ${String(avgMs).padStart(6)}ms` +
        (fellBack ? `  [${fellBack} fell back]` : "") +
        (errored ? `  [${errored} errored]` : ""),
    );

    const invented = testCase.expectNoRecommendations
      ? attempts.filter((a) => (a.recommendations ?? 0) > 0).length
      : 0;
    if (invented > 0) {
      console.log(
        `         ^ invented course-correction on ${invented}/${attempts.length} runs ` +
          `— the next session reads this`,
      );
    }

    if (verdict !== "PASS") {
      const shown = new Set<string>();
      for (const a of attempts) {
        const line = `${String(a.answer)} — ${a.reason}`;
        if (!shown.has(line)) {
          shown.add(line);
          console.log(`         ${line.slice(0, 110)}`);
        }
      }
    }
  }

  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  console.log(
    `\n${count("PASS")} pass · ${count("UNSTABLE")} unstable · ${count("FAIL")} fail` +
      `   (${modelCalls} model calls, ${(totalMs / 1000).toFixed(1)}s total)\n`,
  );

  // Unstable is a failure: a decision that flips on identical input cannot be
  // improved by tuning, because the next measurement is noise.
  process.exitCode = count("FAIL") + count("UNSTABLE") > 0 ? 1 : 0;
}

await main();
