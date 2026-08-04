# MultiHarness

A harness for running a local LLM (ollama/docker) as a persistent, multi-user agent.
Not a chat wrapper: an incoming message triggers a **session**, which runs a configurable
**pipeline** of discrete steps, each with its own prompt, model role, context, and tool allowlist.

**[harness.md](harness.md) is the design spec.** Read it before making design decisions.
It is the source of truth for intent; this file is the source of truth for conventions.

Status: the session loop is closed. `reflect → react → respond → summarize → review` runs end
to end over a CLI adapter, leaving a full session directory, and each session reads the previous
one in the same channel. The knowledge store, the expensive steps, tools, the supervisor loop,
and the web UI are not built yet — see "Not built yet".

## Runtime and process model

**TypeScript on Node 22+.** Chosen over Python specifically to catch shape errors at compile
time rather than in step six of a running pipeline. One schema definition per model output
(Zod) drives the type, the runtime validator, and the JSON Schema handed to ollama for
constrained decoding.

The daemon runs under Node's native type stripping — `node src/daemon.ts`, no build step and no
`tsx`. That imposes two rules: relative imports carry the `.ts` extension, and **no TypeScript
syntax that needs code generation** — no parameter properties (`constructor(readonly x: T)`), no
enums, no namespaces, no decorators. Vitest transpiles via esbuild and will happily accept all
of those, so `npm test` passing is not proof the daemon starts. `npm run typecheck && npm test`,
then actually run it.

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
- **step** — one unit of work in a session (`reflect`, `react`, `research`, `respond`, …).
  Steps have a prompt file, a context spec, a model role, a tool allowlist, and an output file.
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
`reply_target` — is written in **neutral analyst voice**, referring to "the assistant" in the
third person and never addressing the model as a participant. These models are trained to read
"you" as themselves-the-assistant-being-asked, so second person in a classification prompt makes
them conflate "is this aimed at you, the channel participant" with "are you being asked this
question". Injected variables follow the same rule as the file they land in.

Voice is a property of the whole fragment set, not one file: `${situation}` fragments are
injected into `react`, so converting one without the others produces a mixed-voice prompt.

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

## Running it

```
npm install
npm run typecheck && npm test
npm run dev            # CLI adapter; Ctrl-D to exit
```

Model tags in `config/default.toml` are the ones present on this machine. Point
`$MULTIHARNESS_CONFIG` at an override file elsewhere. A role left at `PLACEHOLDER` fails when a
step actually requests it, naming the role and what to do.

A full session with a reply runs ~18s; declining to reply runs ~11s.

## Evaluating steps

```bash
npm run eval                                  # react, 5 runs per case
npm run eval -- --step reflect --runs 3
npm run eval -- --model qwen3:4b --think false
npm run eval -- --case open-question-recent
npm run eval -- --variant react_2             # pin a variant; random sampling
                                              # makes a comparison meaningless
```

Suites live in `eval/cases/<step>.json`. `reflect` cases carry the previous session's sealed
output as `prior`, and `expectNoRecommendations` asserts the step invented no course-correction
— the failure that compounds, since the next session reads whatever it wrote.

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

## Weighted participation

`core/participation.ts`. Damps the agent's tendency to dominate a channel — a failure no
per-message judgement can see, because each individual reply looks locally justified.

`p = base × damping × followup × model`, where damping is `fairShare / agentShare` clamped:
1.0 when the agent is talking its share, below 1 when over. Two-person channels land on 1.0
naturally, so DMs need no special case. Being named is not a probability — it forces the reply,
and no draw is taken. The model's verdict scales the odds (`×1.5` / `×0.5`); it can never turn a
"no" into a reply.

**Off by default** (`[session.participation] enabled`). Turning it on makes the decision
stochastic, which changes what `npm run eval` measures — run the suite with it disabled when
judging a prompt change. Every factor, the probability, and the draw are written to
`trace/participation.json`; a hidden RNG deciding whether the agent speaks would make "why
didn't it answer me?" unanswerable.

## The reflection loop

`reflect` opens a session by judging how the *previous* one in this channel landed, and writes
course-correction that `react` reads via the `reflection` block. It is queued only when
`channels/<id>/last_session.json` points at a prior session, so the first session in a channel
skips it rather than reflecting on nothing.

**`no_signal` is a first-class verdict and usually the right one.** A new question says nothing
about the previous answer; neither does `thanks`. Every recommendation `reflect` writes is acted
on by the very next step *and* read by the following session, so a fabricated critique
compounds. The prompt leads with that, and the fallback claims no signal for the same reason.

Costs ~11s on `digest` — the largest single addition to a session so far.

## Knowledge store

`src/knowledge/`. One sqlite file via Node's built-in `node:sqlite` — **no new dependencies**.
FTS5 ships with sqlite, and the gatekeeper's nearest-topic prefilter runs as cosine similarity
in JS: a few thousand 1024-dimension dot products cost microseconds, which does not justify
`sqlite-vec` and its packaging. `loadExtension` is available if that ever changes.

Topic and namespace are the immutable key — there is no UPDATE path for them. Content is
append-only with provenance. `knowledge` and `identity` are separate namespaces so the research
gatekeeper's shortlist is never polluted with people's names.

**The store is solid; the gatekeeper's judgement is not yet.** Across three live runs on the
same six candidates it produced 0, 0, then 1 append — it fragments one subject across several
near-identical topics, which is the exact failure the design exists to prevent. The prefilter is
*not* the problem: cosine scores are sensible (0.76 between related Docker topics, 0.31 between
unrelated ones) and the shortlist reaches the model.

Leading with "reject conversation state" and "default to append" fixed the first of those
reliably and the second not at all. Do not tune this further by hand — build
`eval/cases/knowledge_gatekeeper.json` first. Note when writing it that some apparent
fragmentation may be correct: `docker nat latency` and `docker macos vm` are arguably different
subjects, and the expectations need deciding deliberately rather than assumed.

## Not built yet

In rough order: an eval suite for the knowledge gatekeeper (see above — it is built but
unmeasured and currently unreliable); tools exposing the store to steps; the Slack adapter via
Bolt with Socket Mode; `plan`/`research`/`reason`/`draft` with full budget enforcement; the
parallel supervisor with cancellation and the per-channel actor; the local web UI.

Sessions currently run one at a time globally, and the wallclock budget is only checked between
steps — a single long step overruns it. Both are resolved by the supervisor milestone.

## Open decisions

Not yet settled — raise them rather than silently picking:

- Knowledge store backing — leaning sqlite (FTS5 for search, `sqlite-vec` for the gatekeeper
  prefilter, one file, one dependency), but not finally settled.
- Session budget model (wallclock, tokens, tool calls) and what happens on exhaustion.
