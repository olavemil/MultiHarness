# Restructuring: assessment and a counter-proposal

A response to [restructuring.md](restructuring.md), grounded in what the code actually looks
like today and in what the Synthetic-Runner (Symbiosis) project does differently.

**Short version.** The diagnosis is right about coupling and wrong about verbosity. The proposed
layering is, to a first approximation, *already built* — and building it again as a v2 would
throw away the measured prompt work that is the expensive part of this repo. One file is causing
almost all of the pain. Fix that file and the two structural gaps behind it, and you get the
benefit the rewrite is reaching for at a fraction of the cost and risk.

---

## 1. What the measurements say

### Verbosity is not the problem

| | lines |
|---|---|
| `src/` total | 14,433 |
| comments | 4,627 (32%) |
| blank | 1,378 |
| **actual code** | **8,428** |
| tests | 9,439 |

8,428 lines of code across 130 files is a small codebase for what it does. The average file is
66 lines. The comment ratio is high by normal standards, but those comments are not padding —
they are the record of measurements that cost real time to take (why `fast` is phi4, why field
order is load-bearing, why `own_subject` was removed). Deleting them is deleting the reason the
prompts are the shape they are.

There is one real verbosity problem, and it is localised:

| file | total | code |
|---|---|---|
| `src/session/run.ts` | 1,647 | 1,033 |
| `src/instance/run.ts` | 801 | 523 |
| everything else (128 files) | — | ~6,870 |

`session/run.ts` is 12% of the code in one file. That is the thing to fix.

### Coupling is the problem, and it has one address

`session/run.ts` contains **19 `step.name === …` branches** across **13 distinct steps** — three
are pre-step setup, the other sixteen are post-step effects — and it imports from **every layer**
of the system:

```
17 from steps/    11 from store/    8 from core/     6 from knowledge/
 4 from model/     2 from tools/    1 each from context/, config/, adapters/
```

It holds **~30 pieces of mutable session state** in a single 1,150-line closure — `reading`,
`stance`, `entryVerdict`, `plan`, `impressions`, `curiosities`, `thinking`, `selfSummary`,
`compactionTarget`, `outreachQueue`, `outreachIndex`, and twenty more — which the 19 branches
read and write.

This is exactly the complaint in restructuring.md: *"construction is spread through the code."*
But the construction that is spread is not prompt construction. It is **effect handling**.

### The layers you asked for mostly exist

The proposal's three layers map onto what is already there:

| proposed | exists today | verdict |
|---|---|---|
| primitives / llm provider wrappers | `model/transport.ts`, `ollama.ts`, `omlx.ts` | **built** — two backends behind one contract, params set only when provided |
| primitives / embeddings | `model/` embed path, `knowledge/similarity.ts` | **built** |
| primitives / io: sqlite, files, markdown | `knowledge/db.ts`, `store/*`, `prompts/load.ts` | **built** |
| primitives / messaging wrapper | `adapters/types.ts` + slack/cli/console | **built** |
| harness / stage interface (name, inputs, outputs) | `steps/types.ts` — `ModelStep` | **built, and better than the sketch** |
| harness / context recipes | `context/builder.ts` + `session/prepareStep.ts` | **built** |
| harness / stage logging | `store/trace.ts` | **built** |
| harness / identities, channels | `store/identityStore.ts`, `channelStore.ts` | **built** |
| agent / stages, prompts as files | `prompts/*.md`, `steps/*.ts` | **built** |
| agent / pipeline configs | `config/default.toml` `[session]` | **partial — see §3** |
| **stage effects (what a stage changes)** | **`session/run.ts`, as 19 branches** | **missing** |

The one line in the proposal that has no counterpart today is this one:

> - auto inputs (dependencies, rules)

…and its unstated mirror, *auto outputs*. That is the whole gap. A step today declares what it
reads (`contextBlocks`, `appendix`) but **cannot declare what it changes**. So everything a step
changes lives in the runner instead.

Concretely, `steps/reflect.ts` declares its inputs beautifully and says nothing about the fact
that running it appends an impression, sets `requestCorrection`, and may schedule synthesis.
Those three effects are 25 lines in `run.ts`, 400 lines away from the step they belong to. Same
for `compact` (writes knowledge), `plan` (writes a revision), `prune` (closes curiosities),
`ponder` (writes thinking), `initiate` (fills the outreach queue), `adjust` (rewrites the queue).

**This is why restructuring a stage prompt hurts.** Not because prompt construction is spread —
it isn't, `prepareModelStep` is a single clean function — but because a stage is only half a
thing. Its other half is in the runner, and you have to hold both in your head at once.

---

## 1b. Typing, ergonomics, and step order

### What TypeScript actually offers instead of an enum

Coming from Dart or Kotlin, the thing to know is that **TypeScript's `enum` is the wrong feature
and you are not missing out by being unable to use it.** In this repo you cannot use it at all:
`tsconfig` sets `erasableSyntaxOnly`, because the daemon runs under Node's native type stripping,
which cannot generate code. Measured against the compiler:

| form | compiles here? |
|---|---|
| `enum Role { … }` | **no** — `TS1294` |
| `const enum Role { … }` | **no** — `TS1294` |
| `declare const enum Role { … }` | yes, but ambient only, so it carries no runtime value |
| **const object + derived type** | **yes** |

Even without that flag, TS enums are widely avoided: a numeric enum accepts *any* number, they are
nominally typed so two identical enums are incompatible, they emit a runtime object that defeats
tree-shaking, and they are awkward to iterate.

The replacement gives you the dotted access you want, and it is the standard idiom:

```ts
export const ModelRole = {
  fast: "fast",
  reasoning: "reasoning",
  digest: "digest",
  embed: "embed",
} as const;
export type ModelRole = (typeof ModelRole)[keyof typeof ModelRole];
```

Declaring the value and the type under one name is deliberate — TypeScript keeps separate value
and type namespaces, so `ModelRole` resolves correctly in both positions and imports stay single.
Verified against the compiler: `ModelRole.reasoning` works, exhaustive `switch` with a `never`
check works, `Object.values(ModelRole)` is typed `readonly ModelRole[]`, and both
`ModelRole.resoning` and `"resoning"` are rejected.

**One difference from Kotlin worth knowing:** the plain string `"reasoning"` also typechecks. The
union is structural, not nominal. That is usually what you want here — config files and JSON carry
strings, so they validate directly against the same type with no conversion layer — but it does
mean the dotted form is a readability convention rather than something the compiler enforces.

### The declarative step shape in your sketch works, with one change

The `ModelStep` literal you wrote compiles essentially as written. The only adjustment is that
`if` is a statement and cannot sit inside an array literal — use `&&`, which reads the same and
narrows properly:

```ts
export const research: ModelStep<Research> = {
  name: "research",
  defaultRole: ModelRole.reasoning,
  voice: ModelVoice.agent,
  context: (i) => [
    "# Research",
    ["## Message", "```", i.message, "```"],
    i.reflection && ["## Reflection", i.reflection.summary],
    i.thoughts   && ["## Thoughts", i.thoughts],
    i.history.length > 0 && ["## Recent messages", ...i.history],
  ],
};
```

with a section type that admits absence, and a composer where **a nested array joins tightly and
the top level joins with a blank line** — which is what makes fenced blocks and heading/body pairs
come out as correct markdown:

```ts
type Section = string | false | undefined | null | Section[];
```

Run against the real compiler and executed, the example above produces:

````text
# Research

## Message
```
hello there
```

## Thoughts
some thoughts

## Recent messages
> a said x
> b said y
````

Note what happened to Reflection: absent, it contributes **no heading, no placeholder, and no
blank line**. That is the "absence is absence" rule this project already enforces in
`context/builder.ts`, and this shape gets it for free rather than by a separate mechanism.
TypeScript also narrowed `i.reflection.summary` inside the `&&` with no cast.

**How this relates to what exists.** Today a step declares `contextBlocks` and `appendix` as
arrays of block *names*, and the builder resolves them, applies per-block truncation budgets, and
picks a heading from the step's voice. Your sketch inlines the literal text instead. The two are
not in conflict, and the honest trade is:

- **Inline composition wins on legibility** — the whole prompt is one readable expression, which
  is precisely the complaint that started this.
- **Named blocks win on the things that were paid for in measurements** — a per-block token budget,
  voice-dependent headings, and the render-time check that catches a template growing a variable
  its step does not declare.

The reconciliation is to keep blocks as named, budgeted resolvers but let a step lay them out
positionally, so a section is either a literal string or a block reference:

```ts
context: (i) => [
  "# Research",
  block("incoming_message"),
  i.reflection && ["## Reflection", block("reflection")],
]
```

That preserves budgeting and the absence rule while giving you the single readable expression.
It is a bigger change than the `as const` work above and belongs after the runner split, not
before it.

### Step names are strings everywhere, and they need not be

The verbosity complaint refines to this: **step configuration is passed as strings, and TypeScript's
enum story makes that feel unavoidable.** It is not. The measurements:

- **9 config keys** are a bare `z.string()` naming a step — `reflect_step`, `read_step`,
  `stance_step`, `restate_step`, `schedule_step`, `respond_step`, `plan_step`, `debrief_step`,
  plus `selectable_steps` / `closing_steps` / `maintenance.steps` / `continuation.steps` as string
  arrays.
- `KNOWN_STEP_NAMES` is typed `readonly string[]`, so the registry **throws away the literal types
  it already has**.
- The runner then compares those strings against step names 19 times.

A typo in any of them is a runtime error at best, and at worst silently disables a feature — the
same class of failure as the `[session.continuation]` TOML sub-table bug already recorded in
CLAUDE.md, where five keys with matching defaults hid a config that had not loaded.

**No enum is needed, and no code generation.** Two probes, both run against this repo's actual
constraints (`--strict --erasableSyntaxOnly`, which forbids enums):

```ts
const ALL = [reflect, read, summarize] as const;
export type StepName = (typeof ALL)[number]["name"];   // "reflect" | "read" | "summarize"
```

That gives a real union. A typo is rejected at compile time. Declaring each step
`as const satisfies ModelStep<Reflection, "reflect">` keeps the literal *and* keeps the shape
check, and a mapped registry narrows per-step types on lookup. The second probe confirmed it
survives the generic `ModelStep<T>` and that `reflect_step: StepName` rejects `"reflekt"`.

For Zod, `z.enum(KNOWN_STEP_NAMES)` then constrains config parsing with the same union, so a bad
step name fails at **config load** naming the file, instead of at the step that reads it — which
in a nine-step pipeline can be minutes in.

Cost: one `as const` per step file, one changed type on `KNOWN_STEP_NAMES`, and the config schema
swapping `z.string()` for `z.enum(...)`. It is a small diff and it deletes a whole class of bug.
**This is the cheapest item on the list and worth doing first**, ahead of the runner split, because
it makes every later move safer.

### Reflect's failures look like step *order*, not prompt quality

The reported symptoms — reflect misreading what the incoming message refers to, and asking whether
it "correctly said nothing" when the message plainly answers the agent's own last message — are
both explained by where reflect sits in the queue.

The message-session queue is built in this order:

```
reflect  →  read  →  stance  →  [restate]  →  schedule  →  …
```

So **`reflect` runs first, and the two steps whose entire job is establishing what the message
refers to run after it.** `read` resolves the reply target (`target`, `addressee`, `wants`) and
`restate` produces the self-contained statement of the task. Reflect is handed the raw
`incoming_message` plus a transcript and is left to infer, unaided, the thing the next step is
about to establish as fact. That is the same mistake this project already documented and fixed
elsewhere: *a question the harness can settle should not be put to a model.*

The second symptom has a specific cause too. `last_contribution` deliberately **resolves to nothing
when the previous session already carries the agent's answer** — added because quoting the agent's
own reply immediately before asking "did it land?" primed `satisfied` and cost two eval cases. The
consequence is that in exactly the case being complained about — somebody replying straight to the
agent's last message — reflect gets no block saying *this is what you said, and this message is a
reply to it*. It has the transcript and must work it out.

**The fix is ordering, and it is what the pseudocode in the follow-up proposes.** Putting
interpretation before reflection means reflect receives the restatement and the resolved target as
inputs rather than re-deriving them:

```
read  →  restate  →  reflect  →  stance  →  schedule  →  …
```

Three consequences worth stating before anyone moves it:

- **`reflect` currently supplies `request_correction` to `restate`** — reflect's finding that the
  *previous* session misread the question. Reversing the order breaks that edge. It is repairable:
  the correction is about the previous session, so it can be read from the previous session's
  sealed `reflection.md` rather than produced fresh this session. That is arguably more correct
  anyway, since it is a fact about a session that has already ended.
- **`restate` is queued conditionally** — only once a reply is settled and only when the channel
  has history. Moving reflect after it means reflect must tolerate the restatement being absent.
  Its `contextBlocks` are already empty and everything is in its appendix, so this costs nothing
  structurally.
- **Reflect runs on `digest` at ~10s.** Moving it later does not change the cost, but it does move
  it behind two `fast` calls, which slightly delays the point at which a session can bail out.

This is the strongest argument in the whole discussion for the `apply`/effects change in §3a plus
the config-driven pipeline in §3c: **the reason reordering feels risky today is that the order is
welded into a ternary in `runSession` and the inter-step edges are implicit in 30 closure
variables.** With the queue in config and the edges declared, swapping two steps is a config edit
and a test run, which is what makes the question answerable by measurement instead of by argument.

---

## 2. What Synthetic-Runner does better, and what it does worse

The Symbiosis project is worth studying for exactly two ideas, and worth *not* copying for the
rest.

### Worth taking: a named vocabulary for inputs and outputs

`library/tools/pipeline.py` gives every stage a declarative source and destination:

```yaml
- stage: distill_messages
  inputs:
    messages: inbox.messages
  outputs:
    summary: memory.inbox_summary
```

`resolve_input` maps prefixes (`memory.`, `pipeline.`, `store.`, `inbox.`, `config.`, `file:`)
to reads; `write_output` maps the same prefixes to writes. A stage is fully described by its
YAML entry. Nothing about `distill_messages` lives in the runner.

That is the missing piece from §1 — and note it is exactly the "auto inputs (dependencies,
rules)" line in restructuring.md, generalised to outputs.

### Worth taking: the context object as the only interface

`InstanceContext` is one object through which species code does everything — `ctx.read`,
`ctx.write`, `ctx.llm`, `ctx.send`, `ctx.store`. Species code cannot reach a vendor SDK or an
absolute path. That constraint is what keeps Symbiosis species small.

MultiHarness has no equivalent. A step *can't* do anything today (steps are pure data + a
`render`), which is safer, but it is why all the doing ended up in the runner. A narrow,
capability-scoped effect context is the middle path — see §3.

### Worth *not* taking: the rest

- **Stringly-typed everything.** `resolve_input` falls through to `return source # treat as
  literal`. A typo in a source name silently becomes a literal string in the prompt. MultiHarness
  throws on an unknown block name and on an unsupplied template variable, and `test/prompts.test.ts`
  renders every variant of every step to catch it at test time. That is strictly better and is
  worth defending in any rewrite.
- **No schema on model output.** Symbiosis has a `response_validator.py`, but nothing like
  MultiHarness's per-step Zod schema driving constrained decoding, validation, one retry, and a
  documented fallback. On local models that machinery is load-bearing.
- **`STAGE_REGISTRY` as a flat dict of Python callables.** Adding a stage means editing a shared
  registry — the same coupling, just smaller.
- **`try: fn(ctx, **inputs) except TypeError: fn(ctx)`.** Swallowing an arity mismatch as a
  fallback is a bug generator.

**The honest summary:** Symbiosis is more modular at the *wiring* level and much weaker at the
*correctness* level. MultiHarness has the opposite profile. Take the wiring idea; keep the
guards.

---

## 3. Counter-proposal: three changes, not a rewrite

### 3a. Give a step an `effects` declaration — the core change

Extend `ModelStep` with an optional effect handler that owns what the step changes:

```ts
export interface ModelStep<T> {
  // …existing: name, defaultRole, voice, contextBlocks, appendix,
  //            buildSchema, fallback, outputFile, render, variables
  apply?(parsed: T, fx: SessionEffects): void | Promise<void>;
}
```

`SessionEffects` is a narrow capability object — the `InstanceContext` idea, scoped to a session:

```ts
interface SessionEffects {
  readonly session: SessionHandle;
  appendImpression(text: string): void;
  writeKnowledge(entryId: number, text: string): void;
  writePlanRevision(r: PlanRevision): Promise<void>;
  closeCuriosity(id: number, reason: string): void;
  setThinking(text: string): void;
  queue: QueueControl;          // replace / append / prepend, budget-checked
  set<K extends keyof SessionState>(key: K, value: SessionState[K]): void;
}
```

Then `steps/reflect.ts` gains:

```ts
apply(r, fx) {
  fx.set("requestCorrection", r.correction.trim());
  if (r.impression.trim()) fx.appendImpression(r.impression);
}
```

…and 25 lines leave `run.ts`. Repeat for the other eight effectful steps.

**What this buys, in the words of the original complaint:** a stage becomes one file you can
read end to end — prompt, schema, fallback, render, *and what it changes*. Restructuring a stage
stops requiring a tour of the runner.

**What it costs:** `SessionEffects` must stay narrow and explicitly enumerated, or it becomes a
god object and you have recreated the problem with an extra layer of indirection. The existing
rule — *no tool writes plans, no step writes knowledge directly* — is preserved by making these
methods route through the same gatekeeper/`writePlanRevision` paths they do now. **A step still
cannot act on its own authority; it declares an intent the harness executes.**

### 3b. Split the runner into four files along the seams already there

`run.ts` has natural joints. Cut along them:

| file | responsibility | ~lines |
|---|---|---|
| `session/queue.ts` | building the initial queue per trigger kind; closing steps; budget truncation | 150 |
| `session/state.ts` | the ~30 mutable fields as one typed record + `blockInput()` derivation | 200 |
| `session/execute.ts` | `executeStep` / `executeModelStep` / `executeComputedStep` / trace / seal | 300 |
| `session/run.ts` | the loop: shift, supervise, execute, apply effects, adjust | 250 |

This is mechanical and test-covered. It does not change behaviour and can be done before 3a or
after, though before is easier.

### 3c. Make the pipeline a config table, not a code path

Today the three trigger kinds build their queues with a ternary inside `runSession`. The
restructuring doc's `on_message` / `background` pipelines want to be data:

```toml
[pipelines.on_message]
entry   = ["reflect?", "read", "stance"]
closing = ["summarize", "review", "debrief?"]

[pipelines.background]
steps   = ["ponder", "compact", "prune", "impression?", "initiate?"]
refuses = ["respond"]
```

The `?` suffix means "only if its precondition holds" — which is the `auto inputs
(dependencies, rules)` line from your doc, expressed as a step-level `available(ctx): boolean`
rather than a runner branch. `maintenance.ts` already computes most of these preconditions; this
just moves the answer next to the step.

---

## 4. On the pipeline changes in restructuring.md

Taking the proposed `on_message` shape point by point against what exists:

| proposed | today | note |
|---|---|---|
| `interpret` (restate + who addressed) | `read` + `restate` | already two steps; `read` is the "who" half and is measured |
| `reflect` | `reflect` | same, and it already reads more than the last session |
| `decide` (respond/react/defer/ignore) | `stance` + `deriveVerdict` | **do not merge this back into one model call.** The four outcomes are *derived in code* from separately-established facts. That was the fix for the mention loop. A `decide` step that re-decodes the verdict reintroduces it |
| optional planned steps as a **stack** | `queue` array + `adjust` | the array already is a stack; `adjust` already pushes to it |
| `respond`, `review`, `background` | same | |

**The one genuinely new idea is the background-work model**, and it is better than what exists.
Today background work is `continuation` (plan-driven, per channel) plus `maintenance`
(housekeeping) plus `curiosity` (cross-channel) — three mechanisms with three trigger paths.
The proposal collapses them into one work list the agent populates at the end of every pipeline
and drains when idle, pausing for messages. That is simpler and it subsumes all three.

The merge rule is the sharp part and worth keeping:

> merge incoming background requests (step_a:"Do task 1") + (step_a:"Do task 2") =
> (step_a:"Do task 1\nDo task 2")

That is the deduplication `curiosity.ts` currently does with an embedding threshold. A literal
concatenation by step name is cheaper and has no unmeasured constant in it.

**One caution.** "While there is background work to do, the agent will keep working" needs the
same closing discipline plans have. `plan` earned `fulfilled`/`abandoned` because *a task list
nothing can close becomes a standing instruction the agent cannot escape*. A background work list
needs an equivalent — a per-item attempt cap, or `prune`'s treatment — or the agent grinds
forever on an item it cannot finish.

---

## 5. Recommendation

**Do not write a v2.** The expensive, hard-won part of this repo is not its structure — it is the
measured prompt behaviour recorded in CLAUDE.md, and the guards around local-model failure
(constrained decoding, schema field order, fallbacks, the render-time variable check, 479 tests).
A rewrite puts all of that at risk to fix a problem that lives in one file.

**Do this instead, in order:**

0. **Type the step names** as §1b. Smallest diff on the list, deletes a whole class of config bug,
   and makes every later move safer because a mistyped step stops compiling instead of failing at
   runtime.
1. **Split `session/run.ts`** into the four files in §3b. Mechanical, test-covered, no behaviour
   change. This alone removes most of the day-to-day pain.
2. **Add `apply(parsed, fx)` to `ModelStep`** and move the effectful branches into their
   steps. This is the change that makes a stage a single readable thing.
3. **Move the queue shapes into config** as §3c, with `available()` preconditions on steps.
4. **Reorder the entry steps** to `read → restate → reflect → stance`, and measure. This is the
   change that addresses the reflect failures in §1b, and steps 0–3 are what make it a config edit
   rather than surgery. Rewire `request_correction` to come from the previous session's sealed
   reflection first.
5. **Then**, on that base, replace the three background mechanisms with the single work list from
   restructuring.md §Background — including a closing rule.

Steps 0–3 are refactors with a green test suite on both sides. Steps 4 and 5 change behaviour, and
by then each is a small change rather than a rewrite.

**Fix first, separately:** three tests are failing on this branch
(`participation.test.ts` ×2, `shippedConfig.test.ts` ×1 — `idle_ms` is 30,000 in config and the
test expects 300,000). Refactoring against a red suite loses the safety net that makes this plan
cheap.
