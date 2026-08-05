# MultiHarness

A harness for running a local LLM (ollama/docker) as a persistent, multi-user agent.
Not a chat wrapper: an incoming message triggers a **session**, which runs a configurable
**pipeline** of discrete steps, each with its own prompt, model role, context, and tool allowlist.

**[harness.md](harness.md) is the design spec.** Read it before making design decisions.
It is the source of truth for intent; this file is the source of truth for conventions;
[roadmap.md](roadmap.md) is what is left to build and in what order.

Status: the session loop is closed. `reflect → react → restate → schedule → [research | reason |
draft] → respond → summarize → review` runs end to end over CLI and Slack adapters, leaving a
full session directory, and each session reads the previous one in the same channel. The
knowledge store, tools, identities, and the supervisor loop are built. Cross-session planning,
scheduled triggers, and the web UI are not — see [roadmap.md](roadmap.md).

## Editing prompts under a running daemon

**`prompts/` is live.** `loadPrompt` reads from disk on every call, but a step's
`contextBlocks` are fixed when the module is imported. Editing a prompt while a daemon runs
therefore hot-patches half the pair, and a template that grows a `${block}` its loaded step does
not declare fails at render time.

Seen live: adding `${current_plan}` to `schedule_1.md` killed a session in a daemon started forty
minutes earlier. `render` throwing is the guard working as designed, and `failure.md` recorded
the whole thing — step, cause, stack, and the partial files — which was its first real use.

Restart the daemon after touching prompts, or accept that the running one is a different build
from the one on disk.

## A TOML table header ends the previous table

`[session.continuation]` and `[session.maintenance]` were added *inside* the `[session]` block, so
six plain keys written after them belonged to a sub-table instead. Zod strips unknown keys, so
they vanished silently.

**Five of the six had schema defaults identical to the file.** Only `reply_target` ever showed a
symptom — it flipped to `false` and turned off a feature measured as worth having, which showed
up as `late-reply-to-agent` scoring 1/3 and looking like a prompt regression. It was not.

Two lessons, and the second is the general one:

- Sub-tables belong at the **end** of their parent's block, which is where they now sit.
- **A default that duplicates the config file hides the config file failing to load.** Every
  value that matters is now asserted in `test/shippedConfig.test.ts` against what the file says,
  not against what the schema would fall back to. That suite also checks the config names only
  registered steps, grants only real tools, and binds every role it asks for.

## Everything ships enabled

This is not a production system and has no external users to disappoint, so the default is **on**:
a feature that is off is a feature nobody finds the bugs in. Breaking fast beats failing silently.

Currently on in `config/default.toml`: `restate`, `debrief`, `reply_target`, weighted
participation, maintenance sessions (impression synthesis + knowledge compaction), and read-only
knowledge tools on `respond`.

Two deliberate exceptions, both because "on" would break the common path rather than exercise it:

- **`[slack] enabled = false`** in the repo default. Slack is per instance — `npm run init`
  writes `enabled = true` into the instance config once it has verified tokens. Enabling it in
  the shipped default makes `npm run dev` a startup error for anyone without `$SLACK_BOT_TOKEN`,
  which kills the CLI path rather than testing the Slack one.
- **The test fixture strips some of it.** `testConfig` turns off `reply_target`, `restate`,
  `selectable_steps`, participation, and `respond`'s tools. Mechanics tests count model calls, and
  each of those adds one; participation additionally makes an outcome depend on a draw, and a
  suite whose results depend on an RNG measures the RNG. **Anything the fixture strips needs one
  test that turns it back on**, or enabling it in config would be untested everywhere — that is
  what `runs respond with the knowledge tools it ships with` exists for.

**Turning `respond`'s tools on is the one change with a standing cost**: an extra model round trip
on every reply, on the latency path. It is the first line to comment out if replies feel slow.

## Runtime and process model

**TypeScript on Node 22+.** Chosen over Python specifically to catch shape errors at compile
time rather than in step six of a running pipeline. One schema definition per model output
(Zod) drives the type, the runtime validator, and the JSON Schema handed to ollama for
constrained decoding.

The daemon runs under Node's native type stripping — `node src/daemon.ts`, no build step and no
`tsx`. That imposes two rules: relative imports carry the `.ts` extension, and **no TypeScript
syntax that needs code generation** — no parameter properties (`constructor(readonly x: T)`), no
enums, no namespaces, no decorators. Vitest transpiles via esbuild and will happily accept all
of those, so `npm test` passing is not proof the daemon starts. `tsconfig` now sets
**`erasableSyntaxOnly`**, so the compiler refuses that syntax rather than leaving it to
discipline. `npm run typecheck && npm test`, then actually run it.

**The harness is a headless daemon.** It runs whether or not anything is displaying it —
messages arrive at any hour, scheduled sessions fire, steps run for minutes. Nothing about the
agent's lifetime is tied to a window being open.

**The GUI is a channel adapter, not a container.** Every transport — Discord, Slack, the local
web UI — sits behind the same channel/identity interface. The primary-user GUI is just a
channel whose identity is the operator: history is channel history, the input box is an
inbound message, the status line is the supervisor's headline snapshot. It attaches and
detaches freely. No Electron — the daemon serves a local page, and types are shared across the
boundary rather than redeclared.

## Vocabulary

Use these terms consistently in code, config, and docs. Don't invent synonyms.

- **channel** — a conversation context (a room, a DM, a feed). State like history and
  last-reflection is tracked *per channel*, not globally.
- **adapter** — a transport binding (Discord, Slack, local web UI) behind the shared
  channel/identity interface. Adapters carry no pipeline logic.
- **identity** — a distinct communication partner. May be human or machine; the agent
  doesn't need to know which. Has aliases (including @mention forms) and a running summary.
- **session** — one run of the pipeline, triggered by a message, schedule, or other event.
- **trigger** — why a session is running: `message` or `maintenance`. Carries the `channelId`,
  which is the universal anchor; the message is optional and absent on an idle run.
- **maintenance session** — a session with no incoming message, run when a channel has gone
  quiet. The sleep phase. Never replies.
- **step** — one unit of work in a session (`reflect`, `react`, `research`, `respond`, …).
  Steps have a prompt file, a context spec, a model role, a tool allowlist, and an output file.
- **schedule** — choosing which steps run in *this* session. A `fast` call, sealed to
  `schedule.md`.
- **plan** — the durable, cross-session planning document, revised as `plan_N.md` under
  `channels/<id>/plans/`. Never use "plan" for in-session step selection: they are different
  lifetimes, and the filenames collide. That is exactly why the in-session one was renamed
  `schedule`.
- **request** — the incoming message restated as a self-contained statement of the task, sealed
  to `request.md` by the `restate` step. Additive: the literal message stays available
  everywhere, and the gap between the two is what makes interpretation drift visible.
- **model role** — `fast` / `reasoning` / `digest` / `embed`. Steps name roles; one table
  binds roles to concrete models.
- **update** — the in-flight supervisor check that runs alongside a step. Distinct from
  the session-entry `react` step; narrower job, own prompt and schema.
- **adjust** — the join point after a step where an `update` verdict is applied.
- **knowledge** — the long-lived K/V knowledge store. Survives sessions.
- **agent files** — the agent's own sandbox filesystem. Survives sessions.
- **session output** — per-session step artifacts. Immutable once sealed.

## Hard rules

**Prompts live in files, never in code.** One `.md` per step under a prompts directory.
Template with `${name}`. Variants are `name_1.md`, `name_2.md`, … selected at random —
and **the selected variant must be recorded in the session output**, otherwise the
variant mechanism is unevaluable and therefore pointless.

**No model names outside the role table.** Steps declare a role (`fast`, `reasoning`,
`digest`, `embed`). One config table binds roles to models and per-role params. Swapping a
model, or defining an alternate profile, must never touch step config.

**Steps run strictly sequentially.** Only one step is ever in flight. The sole concurrency
is the `fast` model running `update` (and quick status replies) alongside the running step.
Consequence: only one large KV cache is ever live.

**Step output is immutable once sealed.** A running step streams to a mutable working file
under `trace/`; the harness seals it into the step's output file at step end, after which
everything — including all agent tools — sees it read-only. Tools may read prior steps and
prior sessions; nothing rewrites history. A cancelled step still leaves its partial working
file, and the supervisor may use it.

**Every model call is parsed against a schema.** Local models produce malformed output
routinely. Use constrained decoding where the runtime supports it, validate the result,
retry once with the validation error fed back, then fall back to a documented safe
default. A step must never crash the session on a parse failure.

**Mentions are matched in code, never judged by a model.** `core/mentions.ts` decides whether
the agent was named; `react` is told the verdict as settled fact. Asking a small model "were you
mentioned?" is a string match dressed as a judgement and it fails badly — a 3.8B model reads
`@dana can you look at this` and concludes it was addressed directly. This leaves the prompt one
genuinely hard question: whether an *unaddressed* message still wants an answer. When the agent
is named and there are no `selectable_steps` to choose between, the entry step has nothing left
to decide and is sealed without a model call at all.

**Situation routing is deterministic; prompt variants are random.** Two separate mechanisms that
must not be confused. `core/situation.ts` classifies conversational position — `mentions_other`
× distance from the agent's last message — and selects a fragment from `prompts/situations/`,
injected as `${situation}`. That keeps one react prompt asking one *specific* question per
situation instead of six near-duplicate prompt files drifting apart. Fragments may themselves
have `_1`/`_2` variants; the trace records `situation` and `situationVariantId` separately so
you can tell which mechanism moved a result.

**Prompt voice follows the model's job.** Steps doing substantial work on `reasoning`/`digest`
— `respond`, `review`, `reflect` — are written in **second person**: they are the agent doing
the work. Mechanical classification on `fast` — `react`, its `prompts/situations/` fragments,
`reply_target` — is written in **neutral analyst voice**, referring to "the agent" in the
third person and never addressing the model as a participant. These models are trained to read
"you" as themselves-the-agent-being-asked, so second person in a classification prompt makes
them conflate "is this aimed at you, the channel participant" with "are you being asked this
question". Injected variables follow the same rule as the file they land in.

Voice is a property of the whole fragment set, not one file: `${situation}` fragments are
injected into `react`, so converting one without the others produces a mixed-voice prompt.

**Work being judged is presented as a third party's.** Distinct from the rule above, which is
about who the model is addressed as; this is about who the *work* belongs to. It matters
wherever a step assesses output the agent itself produced:

- "Have you made progress?" — defensive. Yes.
- "Have I made progress?" — supportive. Yes.
- "Has progress been made here?" — a critical reading, which is the only useful one.

Present the session's output the way channel messages are presented: material to be examined,
authored by someone else. `review` is currently written in second person about its own session
and is the obvious candidate for this treatment — it needed an explicit instruction not to
describe a reply that did not exist, which is exactly the failure this framing prevents. It has
no eval suite yet, so that is a hypothesis, not a finding.

**Every step declares its context.** Context assembly goes through one shared builder that
resolves named blocks (`recent_messages`, `last_review`, `reflection`, `user_summary`, …)
with explicit per-block truncation budgets. Do not hand-assemble context inside a step.
Budgets exist for **answer quality** — local model attention degrades well before the
nominal window — not to avoid OOM. Memory is not the binding constraint here.

**Knowledge writes go through the gatekeeper.** No step writes knowledge entries directly.
A write tool takes candidate text, an embedding prefilter pulls the nearest existing
topics, and a `fast` model returns accept / reject / collides-but-distinct against that
short list. Titles and metadata are immutable; content is append-only with provenance
(session, step, timestamp). Rejections are logged with their reason — reject rate is the
calibration signal for that prompt. Identity entries live in their own namespace, so the
research gatekeeper's topic list is not polluted with names.

**No agent or session data in the repo.** Working directory is external and configurable,
holding agent config, knowledge, agent files, and session output. The repo holds code,
prompts, and default config only.

**Trace everything.** For each step persist the fully rendered prompt, the raw model
response, the parsed result, model id, prompt variant, timings, and token counts. This
system is not debuggable without it.

## Model roles

Target host: Mac, 48 GB unified memory. Metal caps GPU-wired memory at ~75% above 36 GB,
so the real ceiling is **~36 GB**, not 48.

| role | binding | resident | notes |
|---|---|---|---|
| `fast` | `phi4:latest` | 11 GB @ 8k | pinned. On the latency path — react, gatekeeper, `update`. |
| `reasoning` | `qwen3.6:27b` | 17 GB @ 16k | pinned. Primary in-step worker. |
| `digest` | `qwen3.6:27b`, thinking off | shared | empty tool allowlist, enforced by the harness. Re-splitting to a dedicated model is a role-table change only. |
| `embed` | `qwen3-embedding:0.6b` | <1 GB | pinned. Gatekeeper prefilter; unused so far. |

**Measured, not estimated:** 28 GB resident against a ~36 GB Metal ceiling. Resident size runs
well above file size — phi4 is 9.1 GB on disk and 11 GB loaded, because KV cache is included.
Raising `num_ctx` therefore costs real headroom.

`fast` is a judgement role, not a mechanical one. Measured on five addressed/not-addressed
react cases: `phi3.5:3.8b` 2/5 at 0.7s (treats any @mention as itself — it is not reading),
`qwen3.5:9b` 5/5 at 47s (thinking is on), `phi4:latest` 5/5 at 1.7s. Size did not predict this;
measure before swapping.

**Thinking is invisible unless you look for it.** Reasoning models stream it on
`message.thinking`, never in `content`, and ollama excludes it from `eval_count` — a step can
burn 75s and report 45 tokens. The harness captures it to `trace/<step>.thinking.txt` and counts
characters, not tokens, because no honest token figure exists. `[steps.respond] think = false`
cut a full session from ~77s to ~18s.

**`keep_alive = -1` pins permanently.** Swapping models under a pinned role leaves the old one
resident, and it will evict the 27B. `ollama stop <model>` after experimenting.

## Supervisor loop

**Per-channel actors.** Sessions used to run one at a time *globally*, so a message in one
channel waited behind a long session in another. Queues are now per channel and drained
independently; within a channel they stay strictly serial, because per-channel history,
reflection, and the last-session pointer all assume one writer.

**`update` runs alongside the step, not before it** (`session/update.ts`), so the step never
stalls waiting to be told whether to keep going. It sees the step's name and topic — never
partial output, since mid-generation tokens are noise — plus whatever arrived. It judges
**relevance, not progress**: there is no way to tell from a headline whether work is going well.

Verdicts are applied at one join point and nowhere else, which is what makes a verdict about an
already-advanced step safe to apply. `abort` and `respond_now` cancel the step through an
`AbortSignal`; the partial working file survives, which is the reason steps stream to one.
Falling back to `continue` on a parse failure is deliberate — work underway has been paid for.

The daemon supplies `pending()`, because a session cannot see its own queue. **Each arrival is
judged once**, not at every step boundary — without that, one message in a seven-step session
produced seven `fast` calls all reaching the same verdict.

**`adjust` re-schedules the rest of the session**, in light of what has finished: "after this
round of research, is anything else needed before replying?" It shares `schedule`'s schema
because it is the same question at a later moment, and it revises *session scheduling* only —
the durable planning document is a different lifetime and a different step. Once per session:
repeated re-planning is its own failure mode, and sealed output is written once by design.

A step runs as an iterating tool loop. Alongside it:

- `update` triggers on non-empty inbox, debounced, at most one in flight. It sees new
  messages plus a headline snapshot of the running step (step name + intent, as written by
  the triggering `react`/`update`) — not partial output.
- Its verdict is one of `continue` / `adjust` / `abort` / `respond_now` / `defer_to_session`,
  judging **relevance** ("is this still the right step?"), not progress.
- Verdicts are applied only at `adjust`, which joins step and update.
- Steps are cancellable at tool-call boundaries.
- `adjust` may prepend or append steps only while session budget remains. On exhaustion the
  queue truncates to `[respond, summarize, review]`.
- Plan revisions are append-only: `plan_0.md`, `plan_1.md`, … each recording what changed.
- Outbound status sends are rate-limited.

## Code style

- Avoid duplication. Avoid monolithic files. One concern per file.
- Prefer adding a step type or a config key over adding a branch in shared code.

## Working directory layout

Outside the repo, configurable root:

```
knowledge/    K/V store (files or sqlite) — deduped/normalized by a separate pass
files/        agent sandbox filesystem
sessions/     one folder per session: reflection.md, reaction.md, research.md,
              thoughts.md, draft.md, response.md, summary.md, review.md,
              plan_N.md, trace/ (rendered prompts, raw responses, partial working files)
```

## Instances

An agent is a directory. `npm run init` verifies the Slack tokens, takes the bot's name from
Slack rather than from an answer, and creates `~/.multiharness/<bot-name>/` holding:

```
config.toml   identity and settings — no secrets, safe to share and diff
.env          Slack tokens, mode 600
knowledge/ files/ sessions/ channels/ identities/
```

Config is layered, most general first: `config/default.toml` from the repo (conventions and
measured defaults) → `$MULTIHARNESS_HOME/config.toml` (what makes this instance itself) →
`$MULTIHARNESS_CONFIG` (an explicit override, for experiments). `working_dir` defaults to the
instance directory, so an instance is self-contained.

**The daemon hosts all of them at once** — see "One process, every agent" below. `instanceHome()`
survives as the single-agent entry point for scripts and evals, and still refuses to guess with
several present, because a caller that asked for *the* instance would otherwise get the wrong
agent.

**`loadConfig` takes the instance directory as a parameter; tests and evals pass a nonexistent
one.** Without it they read whatever agent is configured on the machine running them. This bit
twice: once in the unit tests, and again in `eval/run.ts`, where a real instance named `galatea`
made every `harness`-mention case silently fail to match — and the misleading results were acted
on before the cause was spotted. `npm run eval -- --home <dir>` evaluates a real instance
deliberately.

**The bot name comes from Slack because mention detection depends on it.** The adapter resolves
the bot's own user id to `agent.name`; a mismatch there makes the agent silently ignore
everyone who addressed it.

## Running it

```
npm install
npm run typecheck && npm test
npm run dev            # every instance on this machine; Ctrl-D to exit
npm run dev galatea    # just that one
```

```
npm run init           # create an instance; verifies Slack tokens
```

Model tags in `config/default.toml` are the ones present on this machine. Point
`$MULTIHARNESS_CONFIG` at an override file elsewhere. A role left at `PLACEHOLDER` fails when a
step actually requests it, naming the role and what to do.

A full session with a reply runs ~18s; declining to reply runs ~11s.

## Evaluating steps

One runner drives any registered step (`eval/runner.ts`), using the same `prepareModelStep` a
session does. A bespoke runner per step meant every new step arrived unmeasured until someone
wrote one, and the three that existed had each drifted from the live path differently. A case
declares which output `field` to judge and how (`equals`, `length`, `empty`, `nonempty`,
`includes`), so a new step needs a case file and nothing else. `knowledge_gatekeeper` keeps a
dedicated runner because it is a write path with store state, not a pipeline step.

```bash
npm run eval                                  # react, 5 runs per case
npm run eval -- --step reflect --runs 3
npm run eval -- --model qwen3:4b --think false
npm run eval -- --case open-question-recent
npm run eval -- --variant react_2             # pin a variant; random sampling
                                              # makes a comparison meaningless
```

`--model` swaps the model bound to `fast` and nothing else, so it cannot answer "would this step
be better on a bigger role?". Point `$MULTIHARNESS_CONFIG` at a file overriding `[steps.<name>]
role` for that — a two-line TOML, and the same layering a real instance uses.

`test/prompts.test.ts` assembles every variant of every registered step through
`prepareModelStep`. `render` throws on an unsupplied variable, so a template that grows a
`${block}` its step does not declare would otherwise fail only when that step next runs — on a
path no test necessarily covers.

Suites live in `eval/cases/<step>.json`. `reflect` cases carry the previous session's sealed
output as `prior`, and `expectNoRecommendations` asserts the step invented no course-correction
— the failure that compounds, since the next session reads whatever it wrote.

**update, phi4, n=3, 6 cases: 5 pass · 0 unstable · 1 fail**, after the verdict set was cut from
five to four.

### `defer_to_session` was removed, and the eval was right three times

It scored 0/3 across three separate measurements, and the model's reasoning was correct every
time: for an unrelated message, "keep doing what you are doing" is simply true. The verdict named
no distinct action, because **an arrival the session does not act on stays in the inbox and gets
a session of its own anyway**.

Item 1d appeared to give it meaning by making `continue` *consume* the arrival, so that deferral
became the exception that kept one queued. **That was the mistake, not the fix.** `continue`
means "this step is still the right step"; it says nothing about the message having been handled.
Consuming on it silently dropped anything unrelated — the message left the inbox and no session
ever answered it. The eval had been pointing at this the whole time and the conclusion was
reversed on bad reasoning.

**Consumption now follows what the session actually did.** `adjust` and `respond_now` mean it
changed course because of the arrival, so it owns the message and owes it an answer. `continue`
and `abort` leave it queued. With that fixed, `separate-matter` scores **3/3** and the fifth
verdict has nothing left to do.

### The remaining failure, and a hypothesis that did not hold

`answered-by-someone-else` has drifted **2/3 → 1/3 → 0/3** across runs: when a bystander supplies
the answer mid-research, the model reads it as useful input (`adjust`) rather than grounds to stop
(`abort`). Arguably defensible, and long documented as a known flake.

A paragraph added to the prompt while cutting the verdict set — explaining which verdicts make
the session own the message — looked like the cause. Removing it changed nothing, 0/3 either way,
so it was not. The likelier explanation is that dropping the fifth option concentrated
probability on `adjust`. **Consumption semantics do not belong in this prompt regardless**: the
step judges relevance, and telling it what the harness does with the answer invites it to
optimise for that instead.

**reflect, phi4-era baseline (qwen3.6:27b via `digest`), n=3: 7/7, no invented
recommendations.** Slow, though: 5–10s per call, the largest single cost in a session.

Cases in `eval/cases/react.json` carry their channel history, because the same message is a
different decision depending on who spoke last — context-free cases disagree with live
behaviour. Prompt assembly runs through `session/prepareStep.ts`, the same code a live session
uses, so the harness can never measure its own copy of the prompt.

**Never judge a prompt change from a single live run.** A decision was declared "unstable" here
on the strength of one run that happened to land the wrong way; at n=5 it was 5/5 consistent
and had already been fixed. `UNSTABLE` is a distinct verdict from `FAIL` for that reason — a
result that flips on identical input cannot be tuned, because the next measurement is noise.

**phi4 latches onto caveats.** Every fragment that stated a rule and then qualified it had the
qualifier swallow the rule — 0/5 on cases the rule plainly covered. Lead with the affirmative
case, make it terminal ("respond, and stop there"), and keep exceptions narrow and concrete.
Fixing that pattern alone took the suite from 7/10 to 9/10.

**Schema field order is load-bearing.** Constrained decoding emits keys in schema order, so a
schema of `{respond, reason}` makes the model commit to the boolean *first* and then rationalise
it. qwen3:4b was caught writing "the message is aimed at me" as the justification for
`respond: false`. Putting `reason` before `respond` is chain-of-thought inside the structured
output, and it costs nothing. Reordering took phi4 9/10 → **10/10** and qwen3:4b 6/10 → 9/10,
fixing a case three prompt rewrites had not moved. **Put the reasoning field before the field it
justifies, in every step schema.**

**`bare-ack-immediate` was not a noise floor.** It sat at 1/5 across several prompt revisions and
was written off here as irreducible borderline noise. Converting react and its fragments to
analyst voice took it to **5/5**, and the suite from 9 pass / 2 unstable to **11 pass / 0
unstable**. Two things changed between those runs — voice and `reply_target` — but an
intermediate run with `reply_target` on and second-person voice still had it at 1/3, which
isolates voice as the cause. A case that resists tuning may be resisting the frame, not the
wording.

**phi4 stalls at roughly 4% of calls** (2 of 55 in one 5-run pass), exceeding the 30s react
timeout with content already streamed. The eval records a timeout as a result and continues
rather than aborting; a live session surfaces it as a failed session. At that rate a 10-case
suite will usually contain one. Do not read a single anomalous run as a regression.

An errored attempt is scored as never-correct. It carries `respond: false`, so scoring it
naively made a timeout *pass* every negative case — `other-thread-absent` was passing on one.
Any new eval dimension needs the same care: the failure value must not coincide with a valid
answer.

**Measured, 3 runs per case, after the reorder:**

| model | score | avg | resident |
|---|---|---|---|
| `phi4:latest` | 10/10 | ~2.7s | 11 GB |
| `qwen3:4b` (think off) | 9/10, 1 flaky | ~1.1s | ~3 GB |

qwen3:4b is ~2.5× faster and ~8 GB smaller for one flaky case. Worth revisiting if residency
gets tight — Qwen3 needs `think = false` here or it blows the react timeout mid-stream.

### `adjust`: 5 pass · 0 unstable · 1 fail, and two defects worth knowing

**It was judging information it could not see.** The prompt asks whether *the new information*
has opened a gap, and the whole premise of the step is that something arrived mid-session — but
`adjust` never declared `mid_session_messages`. Shown no arrival, the model judged the only thing
in front of it, the original task, whose "Still unknown" list reads exactly like a to-do list.
**The eval cases had the same hole**, carrying no arrival either, so the suite measured a state
production never produces. Fifth instance of eval/live drift.

Adding the block alone was close to a wash: `research-empty-do-not-retry` went 0/3 → 2/3, and
`facts-gathered-now-needs-thinking` went 3/3 → **1/3**, because with a fresh question visible the
model reached for `research` to answer it. That is the third confirmed appearance of the failure
below, and the documented lever fixed it — `needs_fact` / `needs_thought` decoded between
`finished` and `steps` took the suite to **5 pass · 0 unstable · 1 fail**, every judgement case
3/3.

Note the two schema corrections do different jobs and both are needed. `finished` leads because
sharing `schedule`'s schema wholesale made the step prejudge that *something* was wanted and never
return empty. The booleans sit after it because once it does decide to add work, it picks
`research` whatever the gap is. Gating first, then discriminating.

**The remaining failure is `no-budget-left`, and production no longer depends on it.** Asked with
an exhausted budget, the step queues research anyway, 0/3 across every revision. Whether another
step fits is *countable*, so the session now skips `adjust` entirely when the budget cannot cover
one — the same rule that keeps mention detection out of a model's hands. The case is kept rather
than deleted because "does the model respect a stated constraint" is worth knowing, and the
answer is no.

### Two supervisor concerns that turned out not to exist

Both were written into the roadmap while the supervisor was being designed and never revisited.
Recorded rather than deleted, because each holds only for a reason that could change.

**Concurrent knowledge writes cannot race in-process.** `node:sqlite` is `DatabaseSync` and there
is no `await` between the gatekeeper's `findEntry` and `createEntry`, so nothing interleaves. It
*can* race across processes — two daemons pointed at one instance directory share the file — so
the unique-constraint failure is now caught and turned into an append. **If that driver is ever
swapped for an async one, the in-process guarantee disappears with it.**

**Two `update` calls cannot overlap.** `await Promise.allSettled([stepRun, updateRun])` blocks the
loop until both settle, so the next step — and therefore the next possible check — cannot begin.
Combined with `judged`, each arrival is ruled on exactly once.

### Open failure: `schedule` reaches for `research` by default

Measured at n=3 over 7 cases: 4 pass, 1 unstable, 2 fail. The failures share one cause, and it
is not the one the first two cases suggested.

Confirmed three times now — here, and twice in `adjust`. **`research` is the generic "do some
work" option; `reason` and `draft` are effectively never chosen.** Every failing case picks `research`:

- `opinion-no-steps` — "sqlite or flat files, which would you pick?" → research 0/3
- `deliberation-wants-reason` — "suggest something better than your gut reaction" → research 0/3
- `direct-question-no-steps` — "rephrase that more simply" → picked `draft` once in three

The step descriptions in the prompt distinguish the three clearly; the model is not using them
to discriminate. Adding an explicit fact-vs-judgement rule, with "asked for a judgement" listed
as a no-steps case, changed nothing at all.

Two prompt rewrites have not moved it, so **do not try a third**. The lever with an actual
argument behind it is the schema: decode `needs_fact` and `needs_thought` booleans *before*
`steps`, so the model commits to what kind of gap exists before naming anything to fill it.
That is the field-order trick that fixed `react` when wording could not, and here it has a
sharper target — the failure is that "what kind of help is missing" is never asked at all.
Running `schedule` on a larger model than `fast` remains the other candidate.

**Baseline, phi4, n=5, 11 cases, corrected scoring:** 9 pass · 2 unstable · 0 fail.
`bare-ack-immediate` sits at 1/5 and is the noise floor described above. Re-measure before
comparing any configuration change against these numbers.

## Reply-target routing

`session/replyTarget.ts` asks a model which earlier message the incoming one replies to, and
`situation.ts` routes on that instead of on distance between messages. Ids come from
`core/window.ts` and are window-local (`m1`…`m12`), never real UUIDs; the schema is compiled
from the ids actually present, so an invalid reference is undecodable.

**On, on evidence.** `late-reply-to-agent` — someone answering the agent after two other people
have talked — scores **5/5 with it on and 3/5 with it off**, at n=5 each. Distance routes that
to `none_recent`; the reply target routes it to `none_immediate`, which is what it actually is,
and that pattern is common in a real channel. It costs a second `fast` call, taking react from
~2.7s to ~5s. One case at n=5 is suggestive rather than conclusive — re-measure if latency
starts to matter.

Note when routing on it: `absent` means *the agent has not spoken here*, which is a fact about
history, not about reply targets. Collapsing "replies to nothing" onto `absent` made
`other_absent` open with "you have not spoken in this conversation" in a thread the agent had
taken part in. Presence stays a question about history.

## The restated request

`steps/restate.ts`, sealed to `request.md` and read downstream through the `request` block.

**The gap it fills.** Several steps received `incoming_message` as their whole statement of the
task, and "could you draft a plan for this?" hands them a pronoun with no referent.
`recent_messages` was present but it is a transcript, not a brief — every step inferred the task
from it separately and differently.

**A step, not a session-level call**, despite being the same shape as `reply_target`. Its output
is consumed by later steps, so it wants sealing, budget accounting, and per-step config — and
above all the generic eval runner. A bespoke path would have been the fifth instance of
eval/live drift.

**Additive, never replacing.** `incoming_message` stays available everywhere. `respond` and
`review` get both deliberately: the gap between the literal message and the restatement is the
only thing that makes interpretation drift visible, and a step handed only the polished version
cannot see that anything was inferred. `restate` is excluded from `prior_step_output` for the
same reason `react` is — it is framing, not work product, and every step reading that block also
declares `request`.

**Queued after `react` decides to reply, and only with history.** That keeps it off the
declining path, which is the common one, and a first message in a channel is already
self-contained.

**`resolved: false` is a reason to ask, not to research.** `schedule` reads it as a terminal
no-steps gate and `respond` asks about exactly the open points. Confidently researching the
wrong interpretation is the expensive failure: it burns a session and reads as authoritative
while answering the wrong question.

### Carrying a reading across sessions, and correcting it

`restate` also reads two blocks the transcript cannot supply: `prior_request`, the previous
session's `request.md`, and `request_correction`, `reflect`'s finding that the previous session
answered the wrong question.

**`last_session_summary` is not prior understanding, despite the name.** `summarize` is a
computed step emitting a table of steps and durations; it records what ran, never what it was
taken to mean. `prior_request` is the block that carries a reading forward, which is why
`PriorSession` now loads `request.md` alongside review, summary, and reflection.

**A correction is a new artifact, never a rewrite.** Sealed output is immutable, so nothing
edits the previous `request.md`. `reflect` emits a `correction` field, the harness passes it
through `BlockInput` the same way it passes `impressions`, and this session's `restate` reads
it — superseding the old reading rather than altering it.

**`reflect` owns it because it is the only step that sees the reaction.** A misread question
produces the most legible signal in the system: the person says "no, I meant the other one".
That is far easier to detect than the vague "did that answer land" judgement reflect otherwise
makes — and it is the recovery path for the one failure below that neither prompt nor model
fixed.

**Measured, and it works.** `correction-overrides-transcript`, `correction-settles-it`, and
`prior-reading-does-not-leak` are **3/3 each**. Detecting the ambiguity up front sits at 0/3;
acting on the person's correction afterwards is reliable. The third case is the one that had to
pass for carrying anything forward to be safe at all: a new question on a new subject must not
inherit the previous session's subject merely because it is in the prompt.

**The distinction it has to hold: dissatisfaction is not a misreading.** An answer can be too
long, or wrong, while the question was understood perfectly. Treating that as a misread reading
would send the next session after a different question than the one asked.

An invented correction is worse than an invented critique — the session's whole understanding of
the question is built from it — so the prompt leads with "usually it was not misread", the
fallback is empty, and three of the five cases assert emptiness.

**reflect, n=3, 12 cases: 12 pass · 0 unstable · 0 fail**, ~10s. All five correction cases pass,
including `dissatisfied-but-understood` — the answer was too long, the question was understood,
and the correction stays empty.

This is the first field here to measure clean on its first run, and it is not luck: the "lead
with the affirmative, make it terminal, keep the empty answer easy" pattern was applied from the
start, having been paid for by `recommendations` and `no_signal` on the same step. The lesson
generalises — a new field on a step whose failure modes are already understood can inherit the
fix instead of rediscovering it.

### Measured: constraints carry; ambiguity does not register

phi4, n=3, 13 cases: **9 pass · 2 unstable · 2 fail**, ~4s. (Before the two carried-forward
blocks were added, 10 cases: 7 pass · 2 unstable · 1 fail.)

**Adding the blocks did not help the ambiguity cases, and may have cost a little elsewhere.**
`unresolved-two-candidates` went 1/3 → 0/3 and `carries-no-dependencies` 3/3 → 2/3. The first is
noise around a case that never worked; the second is a new wobble on the half that was solid, and
it is exactly the cost predicted for a fifth block on phi4 at 8k. Neither is established at n=3
— re-measure at n=5 before treating it as real, and before adding a sixth block for the rolling
digest.

What works is the half that mattered most. Every `carries-` case is 3/3 — a constraint stated
once, early, by somebody other than the last speaker survives into the restatement. A
restatement that quietly drops one is worse than none, because it reads as complete.

**The failure is that ambiguity is resolved by conjunction.** Given two candidate referents the
model does not report two candidates; it writes *"the migration RFC **and** the incident
writeup"* and marks the request settled. Consistent across every failing run, and a coherent
policy — just not the one asked for.

**Field order moved it and did not fix it.** Decoding `request` first put the model in the
position of judging a fluent paragraph it had just written — the same self-assessment failure as
`reflect` inventing critique and `review` describing a reply that did not exist. Deciding
settledness *before* any restatement exists took `unresolved-two-candidates` from 0/3 to 1/3.
Real movement, not a fix. Two levers are spent; **do not try a third prompt rewrite** — the
remaining candidate is the role.

**A bigger model does not fix it, so keep `fast`.** Re-run on `digest` (qwen3.6:27b, thinking
off) via a `$MULTIHARNESS_CONFIG` override: **6 pass · 2 unstable · 2 fail** at 7–10s per call
against phi4's 3–4s. The two ambiguous cases went 1/3 and 1/3 — the same place phi4 landed. A
failure that survives a 3× larger model is not a capability gap, which points back at the schema
or the framing rather than at the role.

**That run also demonstrated the sleep hazard, which is how the hazard was confirmed.** The last
two cases errored on **all six attempts** with 120s timeouts carrying only 250–350 characters,
after eight cases had completed normally. The machine had suspended. `AbortSignal.timeout`
counts wallclock, so every in-flight call died on resume reporting that qwen3.6:27b had exceeded
its deadline — a message that sends you to look at ollama, where nothing is wrong. The same
suspension turned a 543ms `npm test` into 986s.

**Read this signature before believing a timeout:** consecutive total failures, partial content
in hand, and a wallclock figure that does not match the work done. Those two cases are
unmeasured rather than failed, so the digest numbers are a partial comparison, not a baseline.
The conclusion survives because the cases it rests on — the two ambiguous ones — both completed.

**One eval expectation was wrong and was corrected rather than tuned against.** A term the
participants share and the agent does not is *not* an open point: they know what "tier-2"
means, and asking would be pedantry. `resolved-shared-jargon` now asserts `true` and encodes the
distinction the prompt has to hold — unfamiliar is not ambiguous. Following the gatekeeper
precedent: debatable calls get corrected, not encoded as truth.

## Weighted participation

`core/participation.ts`. Damps the agent's tendency to dominate a channel — a failure no
per-message judgement can see, because each individual reply looks locally justified.

`p = base × damping × crowd × followup × model`. Being named is not a probability — it forces the
reply and no draw is taken. The model's verdict scales the odds (`×1.5` / `×0.5`); it can never
turn a "no" into a reply.

**Two damping terms, doing different jobs.** `damping` is `fairShare / agentShare` clamped: 1.0
when the agent is talking its share, below 1 when over. `crowd` is `2 / participants`, clamped at
`crowd_min` and 1.

The second exists because the first does not damp crowding, which is what it looks like it should
do. `fairShare / agentShare` pins to its cap whenever the agent has said little, so a near-silent
agent in a ten-person room was exactly as ready to speak as in a three-person one — and
"comments on everyone else's single message" is a crowded-room failure specifically. Presence
damping only bites once the agent is *already* talking; the crowd term bites from the start.

Two participants gives `crowd = 1`, so a DM is unaffected and still needs no special case.

**Off by default** (`[session.participation] enabled`). Turning it on makes the decision
stochastic, which changes what `npm run eval` measures — run the suite with it disabled when
judging a prompt change. Every factor, the probability, and the draw are written to
`trace/participation.json`; a hidden RNG deciding whether the agent speaks would make "why
didn't it answer me?" unanswerable.

## What `react` returns

Four outcomes rather than a boolean, plus `interest`.

| verdict | meaning | what the harness does |
|---|---|---|
| `reply` | a written answer is wanted | `respond` runs |
| `acknowledge` | addressed to the agent, wants nothing back | marks the message, no reply |
| `for_someone_else` | aimed at another participant | nothing |
| `tangent` | could have been answered, not worth it | nothing |

**A boolean asked an agent's question.** "Was the agent addressed?" is the wrong question
for a conversation partner: under it, somebody sharing a thought correctly produces silence, which
is a real failure seen live. Four outcomes let the step say "this wants acknowledging" or "this is
not mine" without collapsing both into "no".

**`respond` is derived, never decoded.** `wantsReply()` is the single definition, used by the
session *and* by the eval runner — a harness computing its own copy of that rule would be
measuring its own copy, which is the drift this suite exists to catch. The 13 existing cases keep
asserting the same decision unchanged.

**The situation fragments are the authority, and that had to be said explicitly.** They are the
tuned surface — the wording that took `bare-ack-immediate` from 1/5 to 5/5 — and they still ask a
binary question. Widening the verdict set gave the model escape hatches from their conclusion:
`open-question-recent` went to **0/3**, because an open question to the room reads as `tangent`
just as well as `reply`. One added sentence — the situation settles whether a written answer is
wanted, the four outcomes only spell out *how* silence is spelled — took it back to 3/3.

**Measured after that: 13 pass · 0 unstable · 0 fail.**

**`acknowledge` is not gated on participation.** An emoji is not a message, it does not crowd a
channel, and damping it would leave the person with nothing at all — the outcome the verdict
exists to avoid. Being damped into silence is recorded as `tangent` instead, which is honest: the
step judged the message worth answering and the draw disagreed.

**Interest replaced the boolean in participation.** `model` interpolates between
`model_no_multiplier` and `model_yes_multiplier` rather than switching between them; a boolean
threw away everything the step knew, since "barely worth saying" and "I have a real point" both
arrived as `true`.

## Reactions to the agent's own messages

`store/reactionStore.ts`, the `reactions` block, and `reaction_added` / `reaction_removed` on the
Slack adapter. Someone marking a reply is **the most direct evidence `reflect` ever gets** about
how an answer landed — everything else it reads is prose it has to interpret.

**Recorded, never queued.** A reaction is a signal, not a request. Running a session for a 👍
would spend a whole pipeline concluding that nothing was asked, so it is appended and read by
`reflect` at the start of the next real exchange.

**Kept out of `history.jsonl`**, in `reactions.jsonl` beside it. A reaction is not a turn in the
conversation: folding it in would have every step reading `recent_messages` treat an emoji as
something somebody said, and would push real messages out of the window for no gain. Only
`reflect` declares the block.

**Only reactions on the agent's own messages.** Slack reports `item_user`, and one between two
other people is a conversation the agent is not part of — treating it as evidence about its own
answers would be reading somebody else's post.

**A removal cancels the matching addition** rather than appearing as an entry of its own:
somebody trying an emoji and thinking better of it says nothing about the answer. The append-only
log keeps both records, so the retraction stays inspectable; it just is not presented as signal.

**Needs `reactions:read` and the two event subscriptions.** Without them the handler simply never
fires — visible under `MULTIHARNESS_DEBUG=1`, and silent otherwise.

The prompt frames it as a signal rather than a verdict: a 👍 says the reply was received and
welcome, not that it was right, and a single emoji carries far less than a sentence would.

## The reflection loop

`reflect` opens a session by judging how the *previous* one in this channel landed, and writes
course-correction that `react` reads via the `reflection` block. It is queued only when
`channels/<id>/last_session.json` points at a prior session, so the first session in a channel
skips it rather than reflecting on nothing.

**`no_signal` is a first-class verdict and usually the right one.** A new question says nothing
about the previous answer; neither does `thanks`. Every recommendation `reflect` writes is acted
on by the very next step *and* read by the following session, so a fabricated critique
compounds. The prompt leads with that, and the fallback claims no signal for the same reason.

It also decides whether the previous session **understood the question**, which is a different
judgement from whether it answered well, and emits a `correction` when it did not. See "Carrying
a reading across sessions" above — that field feeds `restate`, so an invented one is more
damaging than an invented recommendation.

Costs ~11s on `digest` — the largest single addition to a session so far.

## Knowledge store

`src/knowledge/`. One sqlite file via Node's built-in `node:sqlite` — **no new dependencies**.
FTS5 ships with sqlite, and the gatekeeper's nearest-topic prefilter runs as cosine similarity
in JS: a few thousand 1024-dimension dot products cost microseconds, which does not justify
`sqlite-vec` and its packaging. `loadExtension` is available if that ever changes.

Topic and namespace are the immutable key — there is no UPDATE path for them. Content is
append-only with provenance. `knowledge` and `identity` are separate namespaces so the research
gatekeeper's shortlist is never polluted with people's names.

**Measured: 8/8, n=3** (`npm run eval -- --step knowledge_gatekeeper`). Cases seed the store
with real embeddings, so the prefilter is exercised as it runs live. Expectations were chosen
deliberately: two subjects sharing vocabulary are not automatically one subject, so no case
asserts that a NAT-latency fact and a macOS-VM-architecture fact must merge — genuinely
debatable calls are left out rather than encoded as truth.

**Reject gates go before the append default, and each one is terminal.** The prompt tests, in
order: is this a specific durable fact at all (conversation state, plans, and anything too
general to file are rejected here); does an entry already say it; does an entry cover the
subject; otherwise new. Getting that order wrong is the recurring failure — making "default to
append" emphatic without a preceding duplicate gate took the suite from 7/8 to 5 pass / 2 fail,
because the broad default swallowed the narrow exclusion.

**Concrete examples leak into generated output.** This prompt asks the model to *produce* a
topic string, unlike the classification prompts, and an illustrative example inside it became
the answer: given a deliberately vague candidate, phi4 emitted `metal gpu memory limit` — text
that appeared only in the prompt's own worked example. Explain the distinction abstractly in any
prompt with a free-text output field; quotable examples are safe only where every output is
constrained to an enum.

## Slack adapter

`src/adapters/slack/`. Bolt with Socket Mode — no public URL, which suits a daemon on a laptop.
Enable with `[slack] enabled`; **tokens come from `$SLACK_BOT_TOKEN` and `$SLACK_APP_TOKEN`, never
from config**, which ships with the repo. A missing token is a startup error rather than a
silent fall back to the CLI adapter, which would look like Slack working.

Bolt is the project's only heavyweight dependency — it took `node_modules` from 46 packages to
133 — so it is imported lazily and the CLI path never loads it.

**The bot's own user id resolves to `agent.name`, not to its Slack display name.** Mentions
arrive as `<@U123ABC>`; the adapter rewrites them to display names before the harness sees the
text, and if the bot resolved to whatever the workspace calls it, `detectMention` would miss
every message addressing the agent and it would silently ignore everyone.

Other bots are deliberately *not* filtered — the agent does not need to know whether it is
talking to a human. Only its own messages are, because replying to itself is an unbounded loop.

**Threads are channels by default** (`thread_mode = "separate"`). Per-channel history and
reflection then follow one conversation rather than an interleaving of several, which is what
the harness's per-channel state assumes. The cost is that each thread starts cold and skips
`reflect` on its first session. `"shared"` folds threads into the parent channel instead.

**`MULTIHARNESS_DEBUG=1` logs every event the socket delivers**, before routing and before
filtering, plus the reason any message was ignored. Silence on Slack has two opposite causes —
events not arriving, or the adapter dropping them — and without this there is no way to tell
which. Events arriving at all means the app subscription is fine and the problem is here;
nothing arriving means the bot is not in the channel or is not subscribed to `message.*`.

Slack is the first surface where weighted participation has real multi-participant channels to
run against, and it is now on.

**Standing down rather than racing.** A message nobody addressed waits
`interject_delay_ms`, jittered ±50%, before any work starts. Several agents in one room otherwise
race: each decides independently and as fast as it can, so both answer before either sees the
other. History is read *after* the wait, so `react` simply sees the question has been dealt with
and declines — no coordination channel, no new judgement, and nothing that treats an agent
differently from a person. The jitter matters: two instances with identical config would
otherwise wake at the same moment and race exactly as before.

Skipped when messages are queued behind it — the pause exists to let somebody else speak, and
somebody else already has — and never applied to a message that named the agent.

**Two instances are running side by side** — `galatea` and `nephele`, separate agent names,
aliases, and `working_dir`s, one daemon each. They do not double-answer and their session
numbering cannot collide, because an instance is a self-contained directory.

**An instance seeing another instance as an ordinary participant is intended, not a defect.** It
is the same rule as the Slack adapter not filtering other bots: the agent does not need to know
whether it is talking to a human. The behaviour that follows is the wanted one — a human and one
instance going back and forth keeps that instance engaged through the follow-up multiplier, while
a third instance, having said little, has its damping rise and is more likely to interject with a
different view. Mentions and relevance drive engagement; crowding damps it.

Note what the arithmetic actually does, though, because it is not quite "crowded rooms are
quieter". `damping = fairShare / agentShare`, clamped to 2. More participants lowers `fairShare`,
but an agent that has said little also has a tiny `agentShare`, and the ratio pins to the cap. A
near-silent agent in a six-person room therefore sits at `damping = 2`, the same as in a
three-person one. Crowding only bites once the agent is *already* talking. Whether that is the
intended shape is worth deciding deliberately rather than reading off the formula.

## Tools

`src/tools/`. A tool is a name, a Zod parameter schema, and a handler returning **text** — the
result goes back into a prompt, so it has to be legible to a model before anything else.
Adding one is a definition, a registry line, and a name in a step's `tools` allowlist.

**A step with tools runs in two phases.** Constrained decoding and tool calling cannot both be
in force — pinning the output shape leaves the model no room to emit a call — so the step first
runs an iterating loop, unconstrained, and then makes one schema-shaped call over the transcript
of what the tools returned. Step output stays schema-validated either way.

**Tool failures come back as tool results, never as exceptions.** A name outside the allowlist,
arguments that fail validation, a handler that throws: each returns text the model can read and
correct. The model reaching for something it was not given must not kill the step. The loop
stops at six iterations and says so.

**`knowledge_write` is not a write.** It hands the candidate to the gatekeeper, which decides
whether anything is stored, and reports the verdict back so the model learns what the store
accepts. No step can put an entry in on its own authority. `no_tools` on a role still empties
the allowlist before any of this runs.

## The research step

The first expensive step and the only writer to the knowledge store. Runs a tool loop on
`reasoning` with thinking on, then answers under its schema. `react` chooses it via
`selectable_steps`.

**`react` and `schedule` are separate calls answering separate questions.** `react` decides only
whether to reply; `schedule` decides which steps run, and only once a reply is settled and there
are `selectable_steps` to choose between. Fusing them made one call answer two
unrelated questions and forced `react` to run even when being named had already settled the
first. Split, a named message skips `react` entirely, and a clear-cut "no" costs one call that
never has to pick steps it will not use.

**A named message routes to `prompts/situations/named.md`, not to a positional fragment.** The
six conversational-position fragments all reason about whether an *unaddressed* message is meant
for the agent; handing a named one to `other_absent` tells it the message belongs to someone
else. The fast path used to hide this by short-circuiting before routing.

There is no fetch tool, so "research" today means consulting the knowledge store and the model's
own knowledge. A URL fetcher is a larger decision than it looks: fetched text lands directly in
a prompt, which makes it a prompt-injection surface, and it wants deciding on purpose.

## Steps

| step | role | tools | when |
|---|---|---|---|
| `reflect` | digest | — | second session onward in a channel |
| `react` | fast | — | unless the agent was named |
| `restate` | fast | — | replying, and the channel has history |
| `schedule` | fast | — | replying, and `selectable_steps` is non-empty |
| `research` | reasoning | knowledge search/read/write | chosen by `schedule` |
| `reason` | reasoning | none | chosen by `schedule` |
| `draft` | reasoning | none | chosen by `schedule` |
| `respond` | reasoning | — | replying |
| `summarize` | — | — | always |
| `review` | digest | — | always |
| `debrief` | digest | — | only when messages arrived mid-session |
| `impression` | digest | — | every N impressions, in a maintenance session |
| `plan` | reasoning | none | chosen by `schedule`, and every continuation iteration |

`schedule` picks from them. `draft` writes a first pass with notes for `respond` to sharpen.

### Tool access is the difference between the working steps

Not *whether* a step has tools — which tools. An earlier note here claimed `reason` deliberately
had none; that was an invention, and harness.md says the opposite: it is "expected to make use of
tools to note ideas, perhaps review outside data, but primarily to think about the question at
hand."

| step | internal reads | web | writes |
|---|---|---|---|
| `research` | yes | **yes** | knowledge store |
| `reason` | yes | no | files |
| `plan` | yes | no | files |
| `draft` | yes | no | **none** |
| `respond` | knowledge only | no | none |

Internal reads are `knowledge_search`, `knowledge_read`, `file_list`, `file_read`,
`session_list`, `session_read`.

**Reaching outward is what makes `research` `research`.** Everything else works from what the
agent already has, which is what keeps `reason` thinking rather than gathering — the distinction
the old "no tools" note was reaching for and got wrong.

**`draft` writes nothing at all**, because the draft *is* its output and a step with somewhere
else to put work has two places for it to end up.

**`reason` and `plan` can write files**, because thinking that leaves nothing behind cannot be
built on — and because a plan that names artifacts needs something able to produce them.

## Tools

Implemented, all against the knowledge store:

| tool | access | notes |
|---|---|---|
| `knowledge_search` | read | keyword search over topics, summaries, and content |
| `knowledge_read` | read | opens one topic in full |
| `knowledge_write` | gated | hands a candidate to the gatekeeper, which may refuse it |
| `wikipedia_search` | network | search plus opening extracts; a special-cased site, not a search engine |
| `fetch_url` | network | GET a public page as text; no credentials, no cookies |

### Retrieved text is untrusted, and treated as such

Two hazards, handled in code rather than by asking the prompt nicely.

**A fetched page can address the model.** Retrieved text is fenced and labelled with its source
by `tools/web/untrusted.ts`, and the research prompt states that directives inside it are page
content to be reported, never obeyed — including when passing a claim to `knowledge_write`,
where it becomes "page X states Y" rather than "Y".

**An unguarded fetcher is an SSRF hole here specifically.** The daemon runs beside ollama on
`127.0.0.1:11434`, and URLs arrive in chat messages, so a model can be talked into fetching one.
`tools/web/safeUrl.ts` refuses non-http protocols, and refuses loopback, private, link-local,
and carrier-grade-NAT addresses — **by resolving DNS**, not by matching the hostname, because
`localhost` is a perfectly ordinary name that resolves to `127.0.0.1`. Redirects are re-checked
after the fact. None of that is configurable; `[web] allowed_hosts` narrows further, never
wider.

Planned, from harness.md:

- **agent files** — read/write/list within the sandbox filesystem. Self-contained and low risk.
- **prior session lookup** — read a sealed step output by session number. A reader over
  `sessions/`.
- **news search** — same injection surface as the above, and worth an allowlist.
- **notify / consult** — send a status update or ask a third party. Needs the supervisor's rate
  limiting first, or two agents in a channel will ping-pong.

## Identity impressions

An identity has two parts, deliberately separate. The **record** — id, display name, aliases,
and a running summary — lives in `identities/*.json` and is a stable reference. The
**impressions** live in the knowledge store's `identity` namespace, append-only with
provenance, one observation per exchange.

**`reflect` forms them, not `review`.** Reflect reads how *they* reacted to the last answer;
review judges the agent's own work. Reflect emits an `impression` field and the harness appends
it — the step runs on `digest` with tools refused and cannot write anything itself.

**Synthesis is a separate step**, queued after the closing steps once
`impression_threshold` (5) impressions have accumulated. Running it every exchange would
restate the latest observation and call it a pattern. It writes the identity's `summary`,
which is what every step sees through `user_summary` — the block that was permanently empty
until now.

The impressions it was built from are never rewritten, so a summary that has drifted can be
checked against the record it came from. That is the point of keeping them beside the identity
rather than inside it.

The prompts ask for two things specifically, because they are what should change the agent's
behaviour: what the person wants from an answer, and **whether effort is appreciated** — someone
who never engages with careful work is asking for a fast answer, which is useful rather than a
complaint.

## Three reflection loops, deliberately separate

Easy to conflate, and they answer different questions on different clocks. Nothing here should
be merged into anything else here.

| loop | subject | scope | lifetime |
|---|---|---|---|
| `reflect` | how the last exchange landed | per channel | read by the next session, then superseded |
| `debrief` | how an interruption was handled | per session | only when the session was interrupted |
| `review` | how well the reply served the person | per session | read by the next `reflect` |
| impressions → `impression` | the other person | **cross-channel**, per identity | permanent, revised every N |
| personality insert (4c, unbuilt) | the agent itself | **cross-channel** | permanent, rarely revised |

**The bottom two are the only cross-channel loops, and that is the interesting property.**
Everything else is scoped to a channel and effectively forgotten within a session or two. An
identity's impressions accumulate wherever that person talks, and their synthesis is what every
step reads through `user_summary` — so it is the one place where something learned in one channel
changes behaviour in another. It is a persistent, dynamic, cross-channel reflection process that
was not designed as one; it emerged from making impressions per-identity rather than per-channel.

That is the argument for the personality insert being the same shape applied to the agent
itself, and for it inheriting the same guards: append-only revisions, and a strong default of
leaving it alone. It is also why both need measuring more than the per-channel loops do — a
mistake in a channel-scoped loop expires, and a mistake in a cross-channel one does not.

## Debrief — the only feedback a supervisor verdict gets

`steps/debrief.ts`, sealed to `debrief.md`, queued as a closing step **only when something
arrived while the session was working**. Most sessions never run it.

**Two jobs, and the first is the reason it exists.** A message can arrive mid-session, be judged
once by the supervisor, and then be lost: the session was already committed to another task, it
finished that task, and it stopped. `abort` and `respond_now` make that likely and `continue`
makes it silent — and nothing else in the system would ever notice. `unanswered` is that check.
Arrivals are recorded **whatever the verdict**, including `continue`, precisely because those are
the ones most likely to vanish.

The second job: whether cutting the session short was right. `update` issues verdicts and
`adjust` applies them, and until now nothing ever looked back at one. That blind spot is part of
why `defer_to_session` sat at 0/3 across two prompt revisions before the cause was understood.

**It reaches the next session** through `PriorSession.debrief` and the `last_debrief` block,
which `reflect` reads. Without that it would be write-only: the question it identifies exists in
no other artifact once the session that absorbed it ends.

**Written in analyst voice about a third party's session** — the treatment CLAUDE.md has flagged
`review` as needing and never received. The prompt says the work is somebody else's and to read
it as material to examine. A step asked "did *you* miss anything?" answers no.

**Measured: 8/8, n=3, 0 unstable**, ~6.6s on `digest`. Both directions hold — it reports the
owed question and names it (`staging`), and it stays empty for a remark between two other people,
a thank-you, an arrival the reply already covered, and an abort that was the right call.

Second suite in a row to pass clean on its first run, after `reflect`'s `correction` field. The
tempting read is that the prompt discipline has matured; the more likely one is that **both are
`digest` steps making a retrospective judgement against clear criteria**, which is the shape that
has always worked here. The two open failures are both `fast` steps asked to *discriminate
between options* — `schedule` choosing a step, `restate` detecting ambiguity. That is the harder
job, not the worse prompt.

Untested on `fast`. If a closing digest call proves too slow, moving it is a role-table change —
and would need re-measuring, because the shape above is exactly what might not survive it.

## Cross-session planning

`store/planStore.ts`, the `plan` step, and the `current_plan` block. What lets the agent work on
something over days instead of answering each message in isolation.

**Per channel**, like history, reflection, and the last-session pointer. A channel therefore has
at most one active plan — two goals in one room displace each other. That is a real limitation
and a deliberate one: per-goal plans need a key nothing else in the system has, and there is no
evidence yet that one-per-channel is the binding constraint. The layout is a directory of
revisions, so adding a goal key later does not mean rewriting what is stored.

**Revisions are append-only and sealed 0444**, like step output. `plan_0.md`, `plan_1.md`, … each
records what changed and why, and `plan.json` points at the current one. A plan that overwrote
itself would lose the record of how it drifted — the same reason impressions sit beside an
identity rather than inside it, and it matters more here because a plan *directs* future work.

**One writer, enforced in code.** `writePlanRevision` is called by the harness for the configured
`plan_step`'s output and nowhere else. No tool writes plans, so a step cannot revise one on its
own authority — the same arrangement as knowledge writes going through the gatekeeper, and
enforced the way `no_tools` is rather than by asking a prompt nicely.

### Closing is the load-bearing part

**A plan nothing can close becomes a standing instruction the agent cannot escape.** It would be
read into every future session indefinitely, directing work at something finished months ago. So
`fulfilled` and `abandoned` both make `loadPlan` return nothing, and `current_plan` reads as
absent — while the revisions themselves survive, because closing is not deleting.

`abandoned` exists separately so a plan that turned out to be wrong can be dropped rather than
pursued to exhaustion. The prompt says that abandoning is a good outcome, not a failure to
report, because a model asked to close its own plan will otherwise keep it alive on the grounds
that a little more could always be done.

**`status` decodes before `outstanding`**, so the model commits to whether the plan is running
before listing what is left — a model that writes a list of remaining work first will not then
declare the plan finished.

**An unparsed revision is a no-op, not a default.** The fallback returns an empty goal and the
harness skips the write entirely. Falling back to *something* would let a parse failure close a
plan or replace its goal.

**Measured: 8/8, n=3, 0 unstable.** Both closing directions hold — `fulfilled` when the work is
done, `abandoned` when the goal is overtaken, `active` when progress is not completion — and
`outstanding` empties on close, carries remaining items forward otherwise, and `changed` is
always written.

**55–120s per call, and that is thinking, not contention.** `plan` runs on `reasoning` with
thinking left on, and this file already records what that costs: turning it off for `respond` cut
a session from ~77s to ~18s. The figures are what a deliberative `reasoning` call costs here.

The first explanation reached for was stray daemons holding the models — wrong, and the third
time in this project that a slow measurement was blamed on the environment before the ordinary
explanation was checked. **Check whether thinking is on before blaming the machine.**

That leaves a real decision rather than a mystery: `plan` is genuinely deliberative, which is the
best case for thinking, but it runs while somebody waits for a reply. `think = false` on
`[steps.plan]` is a one-line change and has not been measured against the suite.

### It loads `schedule`, which was already the weakest step

`plan` is a fourth `selectable_step`, and `schedule` already reaches for `research` by default and
effectively never picks `reason` or `draft`. Adding an option to a choice that is not
discriminating well is a real risk, so the suite is re-run against the change rather than
assumed — see below. The prompt states the distinction that matters: `plan` is for the *course of
work*, not for a question that merely happens to be large, because a plan is a commitment later
sessions act on unprompted.

## Continued work

`session/continuation.ts`, a `continuation` trigger, and `[session.continuation]`. After a reply
goes out, the agent carries on with whatever the plan still has outstanding — one iteration at a
time, each a full session of its own.

**A continuation is a new session, not a longer one.** The session is the unit of budget,
tracing, sealed output, and reflection; one that ran for an hour would break all four. It also
makes "resume after handling the incoming message" free — a continuation is just another session
on the channel's drain, so an arrival simply gets there first.

### Progress is counted, never judged

The design this replaced had a step that assessed its own progress, with careful third-person
framing because **a model asked whether it made progress says yes**. Once `plan` exists that step
is unnecessary: an iteration either closed an outstanding item or it did not, and that is a fact
about two plan revisions. Countable facts are settled in code here — the same rule as mention
detection — and this one removes the most defensive judgement in the whole design.

It also collapses "the progress judgement *is* the status update" into something simpler than one
call with two uses: `plan.changed` is written once by the step that revises the plan, and serves
as both the record and the report. There is no second place for the two to disagree.

**Every gate is countable**, and `shouldContinue` holds all of them:

- a reply actually went out — background work on a message the agent declined to answer is work
  nobody asked for;
- a plan is running with items left;
- nothing is queued for the channel, because a waiting message outranks background work and may
  change the plan anyway;
- the last iteration closed at least one item;
- the iteration cap is not reached.

**Closing the plan is reported to the channel that asked**, prefixed `Finished:` or `Dropping:`.
A plan that quietly dies is worse than one that never started, because somebody is still waiting.
Abandoning is reported in the same breath as finishing, deliberately: dropping a plan that turned
out to be wrong is a result.

**`respond` is refused in a continuation**, as in a maintenance session, and neither becomes the
session `reflect` reflects on — there is no exchange in either.

Reaching the iteration cap leaves the plan **active**, not failed. It simply stops being pushed,
so the next real exchange can revive or close it.

## Knowledge compaction

`knowledge/compaction.ts` and the `compact` step. Merges one entry's accumulated notes into a
single coherent statement, in a maintenance session, never on the reply path.

**Nothing is deleted.** A compaction appends a new block and sets `superseded_by` on the blocks
it was built from. `readContents` returns live blocks, so compaction takes effect by existing;
`readAllContents` still returns the originals. That is what resolves the conflict the roadmap
flagged — compaction rewriting entries versus content being append-only. A summary can always be
checked against its evidence, and append-only survives intact.

**Strict on all four axes**, deliberately:

- **Three or more live blocks** to qualify. Two notes are not a pile.
- **One entry per session**, the most-appended. This is the first thing that rewrites what the
  agent knows, so a bad pass touches one topic and a backlog clears over several quiet periods
  rather than in one burst of digest calls.
- **Within an entry only.** Never across entries: topic and namespace are the immutable key, and
  merging two entries means choosing which key survives. Two subjects sharing vocabulary are not
  one subject — the same call the gatekeeper suite deliberately declines to make.
- **`knowledge` namespace only.** Identity impressions have their own synthesis step.

**Anything touching a migrated column belongs after the migration.** An index over
`superseded_by` was written into the schema block beside the table it extends. That block runs
*before* `migrate()`, and on an existing store the `CREATE TABLE IF NOT EXISTS` above it is a
no-op — so the index referenced a column that did not exist yet and threw, taking the whole
session down with `no such column: superseded_by`. It only ever failed on a store written by an
older build.

**The suite could not have caught it**, and that is the more useful lesson: every knowledge test
starts from `openMemoryDb`, which builds the current schema from scratch. A migration is by
definition about databases that do *not* match the current schema, so it needs a test that
constructs the old one deliberately. There is one now.

**The threshold counts notes, not blocks**, and that distinction is load-bearing. A compacted
entry has one live block; counting blocks let two new notes re-qualify it, because the earlier
compaction made up the third — the threshold quietly halving on every pass after the first.
Compaction blocks are excluded from the tally by their provenance step, so "three separate
writes" keeps meaning three writes. Superseded notes are excluded too, which is what stops every
sweep re-compacting the same entry forever.

That bug shipped **with a test asserting it**, comment and all, because the mechanic was observed
and written down as the expectation instead of being checked against the requirement. The same
failure as the gatekeeper case that had to be corrected rather than tuned against: a test written
from the code confirms the code.

**Recompaction currently merges the previous compaction rather than the notes behind it** — a
summary of a summary, which is the compounding shape this project has been bitten by three times.
Roadmap 1c-ter has the fix and the tension it carries (rebuilding from originals means unbounded
input). Nothing has been through a second compaction yet, so it is written down rather than
built.

`applyCompaction` refuses an empty result and does both writes in one transaction. Superseding
several real notes with nothing is the single outcome that genuinely loses an entry; everything
else is recoverable by reading the originals.

**The prompt asks for completeness over brevity**, because the failure mode is losing a fact, not
writing an inelegant paragraph. It also asks for contradictions to be reported rather than
resolved: silently picking between two notes that disagree is how a store starts asserting
something nobody established.

**Measured: 7/7, n=3, 0 unstable** — but read what the suite actually proves. Every case asserts
a specific token survived the merge: a measured figure (`36`, `28`), a version (`22.18`), the
later of two conflicting timeouts (`30`), the losing side of a genuine disagreement (`4b`), and a
fact that shares nothing with its neighbours (`xapp-`). So it proves **those** facts survive, not
that *no* fact was lost — a compaction that quietly dropped something no case names would pass.
That is the limit of a token-matching suite on a free-text output, and the reason the originals
being retained is the real safeguard rather than the eval.

**~13s per call**, several times any other step. Long inputs on the 27B, and it runs in a
maintenance session where nobody is waiting — which is exactly the argument for putting it there.
Real entries will carry more notes than these three-note cases, so expect worse.

## Maintenance sessions — the sleep phase

`core/trigger.ts`, `session/maintenance.ts`, `[session.maintenance]`. A session with no incoming
message, run when a channel has gone quiet. Off by default.

**`channelId` is the universal anchor, not `message`.** That is the whole design. Per-channel
history, reflection, and the last-session pointer are what a session hangs off; a message is one
way of arriving at a channel. Making the trigger explicit is what let a session run without one,
and `BlockInput.message` became optional as a direct consequence — `incoming_message` now says
"nothing was said" rather than rendering empty, which a model reads as a message that said
nothing.

**No entry step, no reply, no `review`.** There is no decision about whether to answer, so
`react` is skipped entirely and the queue comes from config. `respond` is filtered out **in
code** whatever `steps` says: nobody is waiting, and speaking unprompted into a quiet channel is
the agent talking to itself. `review` is skipped because it judges how well a reply served
somebody, and it has already been caught once describing a reply that did not exist. `summarize`
stays — it is computed, and it leaves the session directory a record.

**A maintenance session never becomes the prior session.** `recordLastSession` is skipped, or
the next real session's `reflect` would ask how the last answer landed when there was no answer
and no exchange.

**It fires only when there is work.** `pendingMaintenance` answers "is there anything to do here,
and what?" before a trigger is created, and its answer becomes the trigger's reason and every
step's topic — so no session can appear in `sessions/` unexplained. A maintenance session with
nothing in it opens a directory, spends a digest call, and summarises having done nothing.

**Impression synthesis is the first tenant**, and the reason the item was worth building. It was
queued at the end of every session, where the roadmap noted it had no business being: it is
retrospective, it costs a `digest` call, and the summary it writes is for the *next* session
anyway. Moving it off the reply path costs nobody anything.

That move needed a new marker. The old scheme fired on `total % threshold === 0`, which only
works if the check runs exactly once per appended impression; an idle trigger fires on its own
schedule, so `Identity.synthesisedAt` records the count at the last synthesis and the gate asks
how many are *new*. With maintenance disabled, synthesis stays on the session tail — turning the
feature off must not silently stop it.

### Two bugs this surfaced, both about empty queues

The closing steps are appended from *inside* the step loop. So a session whose queue starts
empty ran nothing and sealed nothing — a session directory indistinguishable from one that never
ran. Reachable as soon as every configured maintenance step could be refused. There is now an
explicit guard before the loop.

The first attempt refused `respond` at dispatch with `continue`, which skipped the closing block
at the loop's foot and produced the same empty directory. **Filtering the queue at construction
is the right place**: one decision, no branch in the hot loop, and the closing steps still run.

### The idle sweep

`daemon.ts`. A timer checks each channel for quiet plus pending work, and **joins that channel's
own drain** rather than running beside it. Per-channel history and the identity record assume a
single writer, so an idle run writing an identity summary while a session read it would be the
exact race the per-channel actor exists to prevent. The timer is `unref`'d, so a pending sweep
never holds the process open.

## Surviving what goes wrong

Four faults from one real session (`galatea/000007`), all now closed.

**Timeouts do not count time the machine was asleep.** `model/deadline.ts` replaces
`AbortSignal.timeout` with a ticking watchdog: a tick that arrives more than 5× late means the
process was not running, so that time is recorded as suspension rather than charged to the model.
Detection is a late tick because Node offers no portable "did we suspend" signal — and the late
tick is evidence of the thing that actually matters, time during which no progress was possible.
Sustained heavy load has the same signature and is treated the same way on purpose: in neither
case was the wallclock time the model failing to answer. The error message now names the
suspension instead of reporting that qwen3.6:27b blew its deadline.

This cost a real measurement before it was understood — a `restate` eval had its last two cases
error on all six attempts and the result was written up as run degradation.

**A timed-out step's partial output is salvaged.** `OllamaTimeout` carries what had streamed, and
`call.ts` tries to parse it, closing brackets and strings the model had not reached. A 27B with
thinking on routinely produces a complete object bar its closing brace; discarding ten minutes of
work over one character is the worst available outcome. **Salvage only ever adds closing
delimiters** — it never invents a field or repairs a truncated value, so anything it returns is
output the model actually produced. A partial missing a required field is discarded, and the
trace records `salvagedFromTimeout`.

**A failed step records why, in the session.** `failure.md` is sealed with the step, the cause,
the stack, and a pointer to the partial working file. Previously a dead session left a partial
with no `meta.json` and the reason existed only in the daemon's console — which is why the cause
of 000007 had to be supplied by hand. In a system whose first rule is trace everything, the
failure path was the one thing untraced.

**A message that arrives mid-session does not start a second one.** `runSession` reports
`consumed`, and the daemon drops those ids from the channel inbox instead of draining them into
sessions of their own. 000006 was running when a follow-up opened 000007: two sessions for one
exchange, the second reasoning about the message with no idea the first was still working.

**This is what finally gives `defer_to_session` a distinct action.** It measured 0/3 against
`continue` across two prompt revisions, correctly — in that build the two did the same thing,
because every arrival got its own session regardless. Now consumption is the default and deferral
is the exception that keeps one queued. The verdict is worth re-measuring; the case for removing
it has gone.

## One call at a time on the large weights

`model/lease.ts`, and `exclusive = true` on `reasoning` and `digest`.

**Two sessions reaching a `reasoning` step together do not get two models.** Ollama holds one copy
of the weights and queues the requests behind each other — but they still look concurrent from
here, so both deadlines run while only one call progresses, and both can time out having produced
nothing. Waiting on this side turns an invisible queue into an explicit one.

**Keyed by model id, not role name.** `reasoning` and `digest` are the same weights with thinking
switched off; a lease per role would let them run concurrently and contend exactly as before.

**`fast` is deliberately not exclusive.** `update` runs *alongside* the step it supervises, so
serialising that role would have the supervisor wait for the thing it is supervising — the one
arrangement the design forbids.

**Waiting costs no budget.** `Budget.waitedMs` accumulates queued time and `workingMs` subtracts
it from wallclock. A session that sat behind somebody else's research has not spent its own
allowance, and charging it would let a busy machine silently shrink every session on it. The
per-step deadline is unaffected for free, because the lease is taken *outside* `chat()` — the
timeout starts when the call does.

**The coordination is the more valuable half.** Two agents answering at the same moment after a
long delay can neither see nor react to each other. Staggered, the second is a session whose
`update` can see the first's answer and adjust or stand down — so serialising for throughput
happens to buy the coordination item 4's deferral is separately reaching for.

FIFO, so a busy channel cannot starve a quiet one and "whoever asked first answers first" holds.
A call cancelled while queued leaves the queue rather than holding its place and then running work
nobody wants.

**Process-wide, and every agent is now in that process.** It began as a guarantee about the
channels of one instance; the shared daemon below made it the cross-instance one, with no change
to this file.

## One process, every agent

`daemon.ts`, `instance/`, `adapters/console.ts`. One daemon hosts every instance under
`~/.multiharness/` instead of one process per agent.

```
npm run dev                 # all of them
npm run dev galatea         # just that one; unknown names are an error naming what exists
MULTIHARNESS_HOME=…         # still means exactly one agent
```

**The reason is the lease and nothing else.** `model/lease.ts` serialises calls per model id, but
it could not reach across process boundaries — two daemons pointed at the same ollama contended
invisibly and timed out together. Sharing a process is what makes the existing code the guarantee
it was written to be. The roadmap's proposed cross-instance *queue* was never needed: the
instances did not need a queue built for them, they needed to be in the same process.

**Nothing else is shared, and that is the property to protect.** Separate config, working
directory, stores, identities, and secrets. There is no guarantee two instances even connect to
the same Slack workspace, so running them together is a resource decision — one machine, one set
of pinned models — and nothing semantic follows from it. `startInstance` reaches everything
through its own `config`, `paths`, `env`, and `log`; there is no module-level state and nothing is
read from the environment after startup.

**`process.loadEnvFile` was the concrete blocker.** It is global, so the second instance's `.env`
overwrote the first's and both would have connected to Slack as whichever loaded last.
`instance/env.ts` reads into a scoped object instead. **The file wins over the environment**,
which inverts what `--env-file` does: with one process per agent, an exported `SLACK_BOT_TOKEN`
was a convenient override; with several, that same export would apply to *every* instance and
silently connect them all as one bot. Verified live — galatea and nephele connect as `U0BMTBXC59C`
and `U0BMPF0A815` from one process.

**One process is one blast radius.** An instance that cannot start is reported and skipped rather
than taking the others down — a missing token is specific to one agent — and the per-channel
drain's existing isolation covers a failed session. Ending the console's input ends the daemon;
an all-Slack daemon runs until it is killed, because a Slack adapter's `closed()` only ever
resolves from its own `stop()`.

**Every line names its agent**, as `galatea [slack]: thinking`. With one process per agent the
process *was* the label; with several, "which of them just failed a session?" is precisely the
question the log exists to answer, and an unprefixed line cannot answer it.

### The console is a room, and that surfaced a real bug

Two `readline` interfaces on one stdin both receive every line and both print a prompt, so the
terminal belongs to `adapters/console.ts` and the CLI adapters attach to it. A line typed there
goes to *every* instance listening, each deciding on its own whether it was for them — the same
arrangement as a Slack channel with two bots in it, which makes participation damping and standing
down testable without a workspace. Measured: with two console instances and one open question,
one answered and the other was damped into silence by its draw.

**Attaching is passive; the daemon calls `ready()` once everyone has started.** Opening the reader
on the first subscriber meant a piped message could be delivered before the second instance had
finished starting — it never saw the line, ran no session, and **the log was indistinguishable
from it having declined to answer**. It was read that way for one run. Interactive typing hides
the race completely, which is why it needs a test rather than a look: `reads nothing until every
instance has attached` fails against the old behaviour.

That is the second time in this file that a *silence* has been misread as a decision, after
`defer_to_session`. Silence is the one output with no evidence in it, so anything that can produce
silence needs a way to tell its causes apart.

## Session budget

`session/budget.ts`. Wallclock alone was never a bound — it is checked between steps, so one
`research` call with a 600s timeout could overrun a 900s session by itself. Model and tool calls
are counted too, because those are what `plan` actually controls now that it can queue research,
reason, and draft together.

Exhaustion is not a failure: the queue truncates to the closing steps, **plus `respond` if a
reply was promised and not yet written**. Someone waiting gets an answer built from whatever was
gathered. A step's timeout is also clamped to the session's remaining wallclock, so a step
cannot outlive the session that queued it.

**The reply is handed over the moment `respond` seals**, through `onReply`, before the closing
steps run. It used to wait for `summarize`, `review`, and `impression` — ten to twenty seconds
of latency after the answer was already written, for retrospection nobody is waiting on.

## Not built yet

See [roadmap.md](roadmap.md). The headline gaps are now **cross-session planning** — a plan that
survives sessions is what lets the agent work on something over days rather than answering each
message in isolation — and **step survivability**: a step that exceeds its timeout loses its
work, a sleeping laptop fails every in-flight step, and nothing in a session directory records
why a step died.

## Open decisions

Not yet settled — raise them rather than silently picking:

- Whether `restate` earns a larger role than `fast`, and whether the restatement should supply
  each step's `topic` instead of `schedule` inventing one separately.
- Whether `defer_to_session` survives. It measures 0/3 because it names no distinct action; it
  gets one only if the supervisor starts consuming arrivals instead of letting them open their
  own sessions.
- Whether plans are per-channel or per-goal, and which step may revise one.
