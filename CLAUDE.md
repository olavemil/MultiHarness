# MultiHarness

A harness for running a local LLM (ollama/docker) as a persistent, multi-user agent.
Not a chat wrapper: an incoming message triggers a **session**, which runs a configurable
**pipeline** of discrete steps, each with its own prompt, model role, context, and tool allowlist.

**[harness.md](harness.md) is the design spec.** Read it before making design decisions.
It is the source of truth for intent; this file is the source of truth for conventions;
[roadmap.md](roadmap.md) is what is left to build and in what order.

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
- **schedule** — choosing which steps run in *this* session. A `fast` call, sealed to
  `schedule.md`.
- **plan** — the durable, cross-session planning document, revised as `plan_N.md`. Not yet
  built. Never use "plan" for in-session step selection: they are different lifetimes, and the
  filenames collide.
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

The daemon supplies `pending()`, because a session cannot see its own queue.

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

With one instance the daemon finds it; with several it refuses to guess and asks for
`MULTIHARNESS_HOME`. Starting the wrong agent is worse than not starting.

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
npm run dev            # CLI adapter; Ctrl-D to exit
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

### Open failure: `schedule` reaches for `research` by default

Measured at n=3 over 7 cases: 4 pass, 1 unstable, 2 fail. The failures share one cause, and it
is not the one the first two cases suggested.

**`research` is the generic "do some work" option; `reason` and `draft` are effectively never
chosen.** Every failing case picks `research`:

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

Slack is also the first surface where weighted participation has real multi-participant
channels to run against; it is still `enabled = false`.

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
for the assistant; handing a named one to `other_absent` tells it the message belongs to someone
else. The fast path used to hide this by short-circuiting before routing.

There is no fetch tool, so "research" today means consulting the knowledge store and the model's
own knowledge. A URL fetcher is a larger decision than it looks: fetched text lands directly in
a prompt, which makes it a prompt-injection surface, and it wants deciding on purpose.

## Steps

| step | role | tools | when |
|---|---|---|---|
| `reflect` | digest | — | second session onward in a channel |
| `react` | fast | — | unless the agent was named |
| `schedule` | fast | — | replying, and `selectable_steps` is non-empty |
| `research` | reasoning | knowledge search/read/write | chosen by `schedule` |
| `reason` | reasoning | none | chosen by `schedule` |
| `draft` | reasoning | none | chosen by `schedule` |
| `respond` | reasoning | — | replying |
| `summarize` | — | — | always |
| `review` | digest | — | always |

`schedule` picks from them. `reason` deliberately has no tools: it exists to think, and a tool loop would turn it back into
research. `draft` writes a first pass with notes for `respond` to sharpen.

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

See [roadmap.md](roadmap.md). The headline gap: sessions run one at a time **globally**, so a
message in one channel waits behind a long session in another. The per-channel actor and the
supervisor loop resolve it and are the next substantial piece.

## Open decisions

Not yet settled — raise them rather than silently picking:

- Knowledge store backing — leaning sqlite (FTS5 for search, `sqlite-vec` for the gatekeeper
  prefilter, one file, one dependency), but not finally settled.
- Session budget model (wallclock, tokens, tool calls) and what happens on exhaustion.
