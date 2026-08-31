/**
 * Eval harness. One runner drives any registered step.
 *
 *   npm run eval                                  # react
 *   npm run eval -- --step plan --runs 5
 *   npm run eval -- --step reflect --case bare-thanks
 *   npm run eval -- --model qwen3:4b --think false
 *   npm run eval -- --variant react_2             # pin a variant; random
 *                                                 # sampling makes a
 *                                                 # comparison meaningless
 *   npm run eval -- --home ~/.multiharness/galatea   # evaluate a real instance
 *
 * Two things it does that a single live run cannot: it replays history, since
 * the same message is a different decision depending on what preceded it; and
 * it repeats each case, because a result that flips on identical input cannot
 * be tuned. UNSTABLE is a first-class verdict, not a rounding error.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { runGatekeeperCase } from "./gatekeeper.ts";
import { runUpdateCase } from "./update.ts";
import {
  describeExpectation,
  matches,
  runStep,
  type EvalCase,
  type StepAttempt,
} from "./runner.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
    home: get("--home"),
    think: get("--think") === undefined ? undefined : get("--think") !== "false",
  };
}

/**
 * An attempt only counts when the answer is the model's own.
 *
 * **Errors** carry the step's documented default, which would otherwise score as
 * right on every case expecting that value — `react` falls back to
 * `respond: false` on error, so a timeout used to pass every negative case.
 *
 * **Fallbacks are the same hazard with the opposite sign, and were missed.** A
 * step that fails schema validation twice also returns its documented default,
 * and `react`'s is `verdict: "reply"` — so a model that cannot hold the output
 * shape passed every *positive* case for free. Found by swapping in a model that
 * actually falls back: `gemma4:e4b-mlx` produced three, two of which landed on
 * want-true cases and were counted as correct. phi4 and the GGUF build produce
 * none, which is why this went unnoticed.
 *
 * The general rule, now stated twice in this file: **any new eval dimension must
 * check that its failure value does not coincide with a valid answer.**
 */
function verdictFor(attempts: StepAttempt[], testCase: EvalCase): Verdict {
  const correct = attempts.filter(
    (a) => !a.error && !a.fellBack && matches(testCase, a.answer),
  ).length;
  if (correct === attempts.length) return "PASS";
  return correct === 0 ? "FAIL" : "UNSTABLE";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Hermetic by default: an eval must not read whatever agent happens to be
  // configured on this machine. A real instance named `galatea` once made every
  // `harness`-mention case silently fail to match.
  const base = await loadConfig(
    undefined,
    args.home ?? path.join(tmpdir(), "multiharness-eval-no-instance"),
  );
  const config: Config = args.model
    ? { ...base, roles: { ...base.roles, fast: { ...base.roles["fast"]!, model: args.model } } }
    : base;

  const file = path.join(HERE, "cases", `${args.step}.json`);
  const suite = JSON.parse(await readFile(file, "utf8")) as { cases: EvalCase[] };
  const cases = args.only ? suite.cases.filter((c) => c.id === args.only) : suite.cases;
  if (cases.length === 0) throw new Error(`No cases matched in ${file}.`);

  console.log(
    `\n${args.step} eval — ${args.runs} run(s) per case` +
      `${args.variant ? `, variant ${args.variant}` : ""}\n`,
  );

  const verdicts: Verdict[] = [];
  let totalMs = 0;

  for (const testCase of cases) {
    const attempts: StepAttempt[] = [];
    for (let i = 0; i < args.runs; i++) {
      try {
        attempts.push(
          args.step === "knowledge_gatekeeper"
            ? await runGatekeeperCase(config, testCase)
            : args.step === "update"
            ? await runUpdateCase(config, testCase)
            : await runStep(args.step, config, testCase, {
                think: args.think,
                variant: args.variant,
              }),
        );
      } catch (cause) {
        // One model failure must not abort the suite — a timeout is a result.
        const detail = cause instanceof Error ? cause.message : String(cause);
        attempts.push({
          answer: "__error__",
          reason: detail,
          ms: 0,
          fellBack: false,
          deterministic: false,
          detail: "error",
          error: detail,
        });
      }
    }

    const verdict = verdictFor(attempts, testCase);
    verdicts.push(verdict);

    const correct = attempts.filter(
      (a) => !a.error && !a.fellBack && matches(testCase, a.answer),
    ).length;
    const avgMs = Math.round(attempts.reduce((n, a) => n + a.ms, 0) / attempts.length);
    totalMs += attempts.reduce((n, a) => n + a.ms, 0);

    const marker = { PASS: "  ok  ", UNSTABLE: " FLAKY", FAIL: " FAIL " }[verdict];
    const fellBack = attempts.filter((a) => a.fellBack).length;
    const errored = attempts.filter((a) => a.error).length;

    console.log(
      `${marker} ${testCase.id.padEnd(24)} ${correct}/${attempts.length} ` +
        `(want ${describeExpectation(testCase)})  ` +
        `${(attempts[0]?.detail ?? "—").padEnd(28)} ${String(avgMs).padStart(6)}ms` +
        (fellBack ? `  [${fellBack} fell back]` : "") +
        (errored ? `  [${errored} errored]` : ""),
    );

    if (verdict !== "PASS") {
      const shown = new Set<string>();
      for (const attempt of attempts) {
        const line = `${JSON.stringify(attempt.answer)?.slice(0, 40)} — ${attempt.reason}`;
        if (!shown.has(line)) {
          shown.add(line);
          console.log(`         ${line.slice(0, 118)}`);
        }
      }
    }
  }

  const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
  console.log(
    `\n${count("PASS")} pass · ${count("UNSTABLE")} unstable · ${count("FAIL")} fail` +
      `   (${(totalMs / 1000).toFixed(1)}s)\n`,
  );

  // Unstable is a failure: a decision that flips on identical input cannot be
  // improved by tuning, because the next measurement is noise.
  process.exitCode = count("FAIL") + count("UNSTABLE") > 0 ? 1 : 0;
}

await main();
