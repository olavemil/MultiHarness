# v2 — a composition experiment

**Not a rewrite, and not a migration.** A parallel folder for experimenting with how steps are
composed, without having to adapt the pieces to a moving v1 at the same time.

**Opt in per instance** by putting `v2 = true` at the top of an instance's own `config.toml`,
above the first `[table]` header. It ships off. Two agents in one daemon can then run the two
pipelines against the same channels, which is what turns `restate → reflect` from an argument
into a measurement.

```toml
# ~/.multiharness/galatea/config.toml
v2 = true
```

The seam is one `if` in `session/run.ts` plus `bridge.ts`, so turning the experiment off is
deleting a folder rather than unpicking a change threaded through the runner. A v2 session seals
into the same session directory, through the same `sealStep`, and returns the same
`SessionResult` — the daemon does not know which pipeline ran.

The underlying primitives are meant to be reused as they stand — `model/transport.ts`,
`model/call.ts`, `knowledge/`, `store/`, `adapters/`. What is being re-composed is the layer
above them: how a step declares its prompt, and what a step is allowed to change.

## What is different, and why

### 1. A prompt is an array of sections

```ts
context: (i) => [
  "# Task",
  "State what is being asked, as a self-contained request.",
  presentAgentAndChannel.onlooker(i.principal),
  i.message && ["## The message", "```", i.message, "```"],
  document("## A correction from the last exchange", i.prior?.correction),
]
```

**An array, not a dictionary**, because order carries two kinds of meaning: what the model reads
first, and whether a phrase like "the draft above" is true. A dictionary expresses neither, which
is why v1 kept a separate ordered `appendix` list beside the block names and relied on the two
agreeing.

**No hidden nesting.** v1 prompts had one `${context}` hole filled from elsewhere, so you could
not tell what a prompt read like by reading it. Here the array *is* the prompt, top to bottom.

`compose` joins a nested array tightly and the top level with a blank line. That one rule is what
keeps a heading attached to its body and a fenced block intact, with no `\n` written by hand.

### 2. No template variables

There is no `${name}` substitution anywhere, so there is no render step that can fail on an
unsupplied variable and no substitution to trace. Prose is assembled from typed values.

This also removes the placeholder-prose failure at its root. v1's own rule is *absence is
absence*, and it is still violated in at least three live places — `lastContribution` returns
"The agent has not said anything in this channel", and `prepareStep` substitutes `(nobody)` and
`(none)`. Here `false | undefined | null` are members of `Section`, so `cond && [...]` is how a
section is made conditional and an absent one contributes **no heading, no placeholder, and no
blank line**. It is not a rule anyone has to remember.

### 3. Sealed documents are demoted, not pasted

`reflect` seals a document opening with an `# Reflection` H1. v1's `reflection` block injected
that wholesale into other prompts, so an H1 landed inside another document's body. v1 managed the
symptom by separating appendices with `----------` rules instead of headings.

`document(heading, body)` demotes every heading in the body to sit under its own, skipping fenced
code, and disappears when the body is empty. The result is one coherent markdown document:

```
## What it is asking

### Request

Which migration to run first.
```

### 4. No voice

v1's `voice: "observer"` was a declared property from which the builder derived a different
heading for every block — action at a distance, with the headings living in the block files rather
than near the prompt they landed in.

Here you name the fragment you want. `presentAgentAndChannel.agent` and `.onlooker` are two
functions returning two pieces of prose, chosen in the step, visible beside everything else in the
prompt. Changing how a step addresses the model is an edit in one file.

The cost is that the variants can drift apart, since nothing keeps them parallel. That is the
intended trade: drift you can see beats consistency enforced by a mechanism you cannot.

### 5. Bounded values look bounded

`ModelRole.reasoning` rather than `"reasoning"`. The argument is readability: quotes say *free
text*, dots say *one of a known set*, and you can tell which is which without reading the
contents.

A TypeScript `enum` is unusable here — `tsconfig` sets `erasableSyntaxOnly` and both `enum` and
`const enum` are rejected with TS1294. The const-object idiom in `values.ts` is better on the axes
that matter anyway: iterable, structurally typed so config strings validate directly, and a typo
fails to compile in both the dotted and bare forms.

### 6. A step declares what it changes

```ts
apply(r, fx) {
  if (r.impression.trim()) fx.impression(r.impression);
  if (r.correction.trim()) fx.note("correction", r.correction);
}
```

In v1 those lines are a branch in `session/run.ts`, 400 lines from the step that causes them.
`Effects` is deliberately a short enumerated list; the moment it can do anything it is the runner
again with extra indirection. A step still cannot act on its own authority, since these route
through the same gatekeeper and plan writer.

### 7. The pipeline is an ordered array

`pipeline.ts` lists the steps in the order they run, each with a `when` predicate over countable
facts. **`restate` runs before `reflect`, reversing v1.** Reflection then reads a settled statement
of the task instead of inferring one from a transcript — which is what the reported reflect
failures look like. Swapping two steps is moving two lines.

## Layout

| file | what it holds |
|---|---|
| `compose/section.ts` | `Section`, `compose`, `demote`, `document` |
| `compose/fragments.ts` | agent/onlooker prose variants — the voice replacement |
| `values.ts` | `ModelRole`, `StepKind` |
| `steps/types.ts` | `Step`, `Effects` |
| `steps/input.ts` | `StepInput` — typed values, not pre-rendered markdown |
| `steps/restate.ts`, `steps/reflect.ts` | two steps in the new style |
| `pipeline.ts` | the ordered message pipeline |
| `run.ts` | the session loop — reuses v1's `callModel` and role table |
| `bridge.ts` | adapts v1's session values into `StepInput` |
| `../../test/v2compose.test.ts` | 18 tests over composition |
| `../../test/v2flag.test.ts` | 6 tests that the flag routes and v1 is unaffected |

## Status

Typechecks under `erasableSyntaxOnly`; 24 tests pass across `v2compose` and `v2flag`; v1's own
behaviour is unchanged, asserted by a test that the v1 ordering still holds with the flag off.

**Not built yet**, deliberately — these are the parts that should reuse v1 rather than be
reinvented, and they only need writing once the composition above is settled:

- **`respond`.** The pipeline is `restate` and `reflect`, so a v2 session composes prompts and
  sends no reply. An instance on `v2 = true` is therefore a prompt-composition comparison, not a
  conversational agent — do not point one at a channel where somebody is waiting for an answer.
- **Maintenance and continuation triggers.** The flag routes message sessions only; those still
  run v1, because silently doing nothing on them would look like a wedged daemon.
- **Per-section token budgets.** v1 has them per named block; the positional equivalent is
  untested and is the one thing the array might make harder rather than easier.
- **Tool loops**, `Effects.knowledge` and `Effects.requeue`, and the other nineteen steps.

**The measurement that matters** is whether `restate → reflect` fixes the reflect failures. That
is a live comparison, not a unit test, and it is the reason this folder exists.
