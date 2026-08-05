# Roadmap

What is left, in the order I would build it. [harness.md](harness.md) is the spec;
[CLAUDE.md](CLAUDE.md) is the conventions and the measured findings. This file is the plan.

Each item carries the design decisions it will actually run into — several of them were
discovered the hard way while building what already exists, and are cheaper to know in advance
than to rediscover.

---

## Where things stand

Built and measured: the session pipeline (`reflect → react → restate → schedule → [research |
reason | draft] → respond → summarize → review → [impression]`), the knowledge store with its
gatekeeper, identities with append-only impressions, five tools, CLI and Slack adapters, and
six clean eval suites (react 13/13, reflect 12/12, gatekeeper 8/8, debrief 8/8, compact 7/7,
plan 8/8) plus `restate` at 9/13.

A reading of the question now survives across sessions — `prior_request` carries the previous
session's `request.md` forward, and `reflect` emits a `correction` when the new message shows
that reading was wrong. Both halves measure clean: reflect never invents a correction (3/3 on
each of three negative cases) and restate acts on one when given it (3/3).

Built but unmeasured: `reason`, `draft`, `impression`, `respond`.

Built with a characterised failure, each written up in CLAUDE.md: `schedule` reaches for
`research` by default and effectively never picks `reason` or `draft`; `restate` resolves an
ambiguous referent by conjoining both candidates rather than reporting either; `update` scores
0/3 on `defer_to_session`.

Triggers are explicit now: a session runs from a `message` or a `maintenance` trigger, and the
sleep phase exists. Impression synthesis has moved off the reply path into it.

Knowledge compaction is built, strict, and measured 7/7: three or more notes under one entry, one
entry per maintenance session, within an entry only, and nothing is ever deleted — a compaction
supersedes the notes it merged and they stay readable.

The survivability items are closed. Timeouts no longer count time the machine slept, a timed-out
step's partial output is salvaged rather than discarded, a failed step seals `failure.md` saying
why, and a message arriving mid-session is absorbed instead of opening a second session for the
same exchange.

**Everything built is now enabled by default** — participation, maintenance, compaction, restate,
debrief, reply_target, and read-only knowledge tools on `respond`. Slack stays per-instance.
Nothing is waiting behind a flag, so the next bugs found will be found by running it.

Not built: agent-files tools, the `message` step, the web UI, the rolling digest.

---

## 1. Supervisor loop — mostly done

Built: the per-channel actor, `update` running alongside steps, verdicts applied at a single
join, and cancellation via `AbortSignal` on `abort` / `respond_now`.

**Still open:**

- ~~`adjust`~~ — built. Re-schedules the remainder of the session from what has finished; does
  not touch the durable plan, which is a separate lifetime.
- ~~`defer_to_session`~~ — **removed.** Re-measured after 1d, as promised, and the re-measure
  showed 1d's reasoning was wrong: making `continue` consume arrivals silently dropped unrelated
  messages. Consumption now follows `adjust` / `respond_now` only, which leaves the fifth verdict
  with no distinct action — the conclusion the eval reached three times. Suite: **5 pass · 0
  unstable · 1 fail**.
- ~~**Concurrent knowledge writes**~~ — checked, and the race does not exist in-process:
  `node:sqlite` is synchronous and nothing awaits between the gatekeeper's lookup and its insert.
  Handled defensively for the cross-process case anyway. See CLAUDE.md.
- ~~**One `update` in flight**~~ — already guaranteed: the step loop awaits both the step and the
  update before advancing, so two can never overlap.
- ~~`update` eval~~ — built, 6 cases, 4 pass / 1 unstable / 1 fail. It found the
  `defer_to_session` redundancy above on its first run.
- ~~**No eval suite for `adjust`**~~ — six cases, now **5 pass · 0 unstable · 1 fail**. Found two
  real defects: the step could not see the arrival it was asked to judge, and it reached for
  `research` whatever the gap was. The remaining fail is the budget case, settled in code.
- ~~No feedback on verdicts~~ — `debrief` closes an interrupted session by judging how the
  interruption was handled, and reports anything that arrived and was never answered. The first
  thing that ever looks back at a verdict. **8/8 at n=3.** See CLAUDE.md.
- **Partly run live.** `update` has fired and returned a verdict, and `debrief` has closed a
  session on the back of it. What has *not* fired: `adjust`, `abort`, `respond_now`, and message
  consumption — all of which need an arrival landing mid-step. With `respond` at `think = false`
  a session is ~18s, so the window is narrow; it will open naturally once a `research` or `reason`
  step is in play on Slack.
- **A step could run twice and fail to seal.** Found by a test: `respond_now` and `adjust` are
  both guarded on `reply === undefined`, but the reply was recorded *after* the verdicts were
  applied, so a verdict arriving on `respond`'s own completion read a stale `undefined` and queued
  `respond` again. Sealed output is `chmod 444`, so the second seal failed with `EACCES`. Fixed by
  recording the reply before the verdicts.

---

## 1b. Original scope, for reference

Sessions currently run **one at a time globally**. A message in one Slack channel waits behind a
five-minute research session in another. That is the single worst property of the system as it
stands, and it gets worse as more channels are added.

**Scope**

- Per-channel actor: one session in flight per channel, channels independent of each other.
- `update` runs on `fast` alongside the running step, triggered by a non-empty inbox, debounced,
  at most one in flight.
- It sees new messages plus the step's headline (name + topic), never partial output.
- Verdict: `continue` / `adjust` / `abort` / `respond_now` / `defer_to_session`.
- Verdicts apply only at `adjust`, the join point after a step.
- Steps become cancellable at tool-call boundaries.

**What the existing code already gives you**

The tool loop in `model/toolLoop.ts` iterates over tool calls, and those iterations are exactly
the cancellation points. The queue in `session/run.ts` is data rather than control flow, which
is what lets `adjust` rewrite it. The budget added alongside this roadmap already bounds what
`adjust` may append.

**Decisions it carries**

- `update` needs its own prompt and schema, and analyst voice: it is a `fast` classification.
  It is **not** `react` — same family, different question. Naming them alike will confuse config
  and traces.
- Outbound status sends need rate limiting before `respond_now` exists, or a busy channel gets a
  progress line every few seconds.
- Per-channel actors mean concurrent knowledge writes. The gatekeeper is a read-then-write
  sequence with no transaction around it; two sessions writing the same topic can both decide
  "new".

---

## 1c. The request, restated — built

`steps/restate.ts`, sealed to `request.md`, read through the `request` block by `schedule`,
`research`, `reason`, `draft`, `respond`, and `review`. Queued once `react` has decided to reply
and only when the channel has history; `[session] restate_step = ""` turns it off. It also reads
`prior_request` — the previous session's reading — and `request_correction`, `reflect`'s finding
that the previous session answered the wrong question. Measured at n=3 over 13 cases: **9 pass ·
2 unstable · 2 fail** — see CLAUDE.md for what that means.

**Still open, in the order I would take them:**

- **Ambiguity does not register.** Given two candidate referents the model conjoins them and
  calls the request settled. Field order moved `unresolved-two-candidates` from 0/3 to 1/3 and
  no further, and `digest` — a 3× larger model — lands in the same place at 2–3× the latency.
  Three levers spent. What has not been tried is removing the judgement: an ambiguous referent
  is partly a *countable* property, and `core/window.ts` already gives window-local ids, so
  "which message does the final one point at, and is there more than one candidate?" could be
  asked the way `reply_target` asks its question rather than left to a free-text verdict.
  **Lower priority than it was**, because the correction loop now recovers from it after one
  round trip, at 3/3. Detecting it up front saves an exchange; it no longer prevents an answer.
- **Whether `resolved: false` behaves end to end.** `schedule`'s no-steps gate and `respond`'s
  ask-instead-of-answer branch are both written and neither has been exercised, because nothing
  has produced a `false` yet outside the eval.
- **Pre-window memory.** `prior_request` carries the previous session's reading forward, which
  covers n-1 and nothing older. A conversation that has moved past the 12-message window still
  loses everything before it except whatever `research` happened to write to the knowledge
  store. The chosen shape is a rolling digest — see below.
- **Whether it replaces `topic`.** Still undecided, and now cheap to test: `schedule` sees the
  restatement, so a topic derived from it rather than invented separately is a small change.

**The original statement of the gap**, kept because it is what the design answers:

Several steps receive `incoming_message` as their whole statement of the task.
"Could you help me draft a plan for this?" gives them a pronoun with no referent — the details
are spread across earlier messages, often from several people and sometimes from the agent
itself. `recent_messages` is present but is a transcript, not a brief: a step has to infer the
task from it, and each one infers separately and differently.

**The shape.** One call per session that boils the recent conversation down to a fully qualified
statement of what is being asked, sealed as `request.md` and exposed as a `request` context
block. Same shape as `reply_target` — a session-level call rather than a pipeline step — but
sealed rather than merely traced, because everything downstream depends on it.

**It is independent of scheduling.** It produces a standalone artefact: the message as it would
read if the person had stated it in full, without reference to what work might follow. Deciding
what to do about it is a separate question, asked afterwards with this in hand.

### A discrepancy is a result, not a failure

The output cannot be only a confident sentence. When the arriving message leans on context the
history does not actually resolve — "draft a plan for this", where *this* could be two things —
saying so is more useful than picking one:

```
reasoning     how the message and the history fit together
request       the fully qualified statement
resolved      whether the history genuinely settles it
unresolved    what remains ambiguous, when it does not
```

**`resolved: false` is a reason to ask, not to research.** Confidently researching the wrong
interpretation is the expensive failure here: it burns a session, produces a reply about the
wrong thing, and reads as authoritative while doing it. A one-line clarifying question costs
seconds and is what a person would do.

That needs no new step or verdict. `schedule` sees both the literal message and the restatement,
and with `resolved: false` chooses no steps — answering directly *is* asking. `respond` reads
`unresolved` and asks about exactly those points rather than guessing.

**Both go to whatever decides.** The literal message and the restatement are different evidence:
the gap between them is the signal. A step given only the polished version cannot see that
anything was inferred.

**Which steps read what**

| step | reads |
|---|---|
| `react` | the literal message only — it judges *addressing*, and the actual words are the evidence |
| `schedule`, `research`, `reason`, `draft` | the restated request — they need the task, not the wording |
| `respond` | both — it must answer the actual message in its own terms |
| `review` | both, deliberately: comparing them is the only way interpretation drift becomes visible |

**Additive, never replacing.** `incoming_message` stays available everywhere. A bad restatement
that silently replaced the words would poison every step downstream with nothing to check it
against, which is exactly the failure `review` seeing both is meant to catch.

**When to skip it.** No history means nothing to boil down; a first message in a channel is
already self-contained. Running it only after `react` has decided to reply also keeps it off the
declining path, which is the common one.

**How the decisions it carried came out**

- **Role.** Shipped on `fast`, and measured against `digest` rather than assumed: the larger
  model is 2–3× slower and no better on the cases that fail. Settled.
- **The failure mode to measure** — a restatement that quietly drops a constraint stated once,
  early, by somebody other than the last speaker. Three cases of exactly that shape, **3/3
  each**. This is the half that had to work and it does.
- **Calibrating `resolved`** — it needed the treatment every binary here has needed, and one it
  had not: the affirmative case stated first and terminal, and `resolved` decoded *before* the
  restatement rather than after it. Both directions are in the suite. The false direction is
  still the open failure above.

---

## 1c-bis. Rolling memory past the message window

**The gap.** `recent_messages` carries what the daemon passes (40 messages, truncated to a token
budget); `message_window` carries 12 with local ids. Everything older is gone. A channel that has
been active for a week has no memory of its own first half, except by accident — whatever
`research` happened to file in the knowledge store.

**Not a chain of restatements.** The obvious cheap idea is to read `request.md` from older
sessions, since those are already sealed and cost no model call. It does not work as a
conversation summary: a restatement is *what was asked*, so chaining them yields a list of past
questions with every answer omitted — and only for sessions where the agent replied, since
`restate` sits on the answering path. Two further obstacles: sessions are not messages, and
`last_session.json` points only at the most recent one, so "the session that handled the message
which just left the window" is not addressable without a new index.

**The shape: a rolling digest.** Once per session, `(previous digest + the messages that just
left the window) → new digest`. That is the thing that actually carries a conversation forward,
including the agent's own contributions.

**Decisions it carries**

- **Cost.** One `digest` call per session, ~11s — comparable to `reflect`, already the largest
  single addition to a session. Two `digest` calls per session is a real latency change and
  wants measuring against the sleep-phase alternative: this is retrospective work, and item 2
  argues retrospection belongs in idle time rather than on the reply path.
- **Compounding, and why it is tolerable here.** Each digest derives from a digest. That is the
  shape that has burned this project twice — but unlike `reflect`'s recommendations it is
  *checkable*: `history.jsonl` is append-only ground truth, so a drifted digest can always be
  diffed against what it came from. Follow the impressions precedent: append revisions, never
  rewrite, so the originals survive the summary built from them.
- **Which steps read it.** `restate` is the natural primary consumer — "the thing we discussed
  last week" is exactly a reference pointing outside the window. But it runs on phi4 at 8k with
  four blocks already, and the measured lesson across `react`, `schedule`, and the gatekeeper is
  that fewer, tighter inputs classify better. It has a suite; add the block, add cases whose
  referent lies outside the window, and re-run rather than assuming it helps.
- **Triggering.** Cleanest when a message actually falls out of the window, which is not every
  session. A digest that runs when nothing has aged out is pure cost.

---

## 1c-ter. Recompaction should go back to the notes, not to the last compaction

**The problem.** An entry that has been compacted once and then written to again currently
recompacts from its *live* blocks — which include the previous compaction. Given writes
`a, b, c`, a compaction `X`, and then `d, e, f`, the second pass merges `(X, d, e, f)`. `X` is
already a lossy summary of `a, b, c`, so `Y` is a summary of a summary, and whatever `X` dropped
is now unrecoverable in practice even though `a, b, c` are still on disk.

That is precisely the compounding shape this project has been bitten by three times —
`reflect`'s recommendations, the impression summary, and the personality insert — and the answer
each time was to keep the originals and rebuild from them rather than from the last derivation.

**The fix.** Recompact from the original notes, ignoring intermediate compactions:

```
stack:  a, b, c, X, d, e, f      (X is the first compaction)
now:    compact(X, d, e, f)  ->  Y      # summary of a summary
want:   compact(f, e, d, c, b, a) -> Y  # newest first, straight from the notes
```

`readAllContents` already returns everything, and compaction blocks are identifiable by their
provenance step, so the query is the only piece missing.

**Reverse order is a separate idea and probably a good one on its own.** Presenting newest-first
makes recency *structural* rather than something the model has to infer from timestamps — and
"a later note supersedes an earlier one" is currently a sentence in the prompt doing work the
ordering could do for free. It applies to a first compaction just as much as a recompaction. It
is cheap, and it changes what the suite measures, so it wants re-running rather than assuming.

**The tension to resolve before building it.** Rebuilding from all originals means the input
grows without bound: an entry written to fifty times feeds fifty notes to the model every pass,
and eventually blows the context budget the compaction was supposed to relieve. The current
scheme is bounded precisely because it compounds. Options, none measured:

- Rebuild from originals up to a cap, then fall back to including the last compaction — accepts
  one level of compounding, bounded.
- Keep a generation count and only rebuild fully every N compactions.
- Accept unbounded input and rely on `num_ctx`; simplest, and fine until an entry gets large.

**Not urgent.** Repeated writes to one topic are an unknown quantity — nothing has been through a
second compaction yet, and the shape of the problem depends on how often that actually happens.
Worth revisiting once the store has real traffic.

**Already fixed, separately:** the threshold counts *notes* rather than live blocks, so a
compacted entry needs three fresh writes to re-qualify. Counting blocks let the earlier
compaction make up the third, halving the threshold on every pass after the first.

---

## 1d. Making steps survivable — built

Three faults from one real session (`galatea/000007`), plus the missing failure record. All four
are closed; see CLAUDE.md for the design of each.

- ~~**Steps must have room to finish.**~~ A timed-out call now carries its partial output, and
  `call.ts` parses it by closing brackets and strings the model had not reached. Salvage only
  ever *adds* closing delimiters, so it can never invent a field. The other two options — capping
  thinking with `num_predict`, and sizing timeouts to the role — remain untried and unneeded so
  far.
- ~~**A timeout must not fire because the machine slept.**~~ `model/deadline.ts` ticks and treats
  a tick more than 5× late as suspension, which is not charged against the budget. The message
  names the suspension rather than the model.
- ~~**No new session while one is in flight.**~~ `runSession` reports `consumed`; the daemon
  drops those ids from the inbox. **`defer_to_session` now has a distinct action** — it is the
  exception that keeps an arrival queued — so its 0/3 score is worth re-measuring and the case
  for deleting the verdict has gone.
- ~~**A failed step should say why.**~~ `failure.md` is sealed with the step, the cause, the
  stack, and a pointer to the partial.

**Still open**

- **Never exercised live.** Suspension, salvage, and absorption are all covered by tests and none
  has happened in a real session.
- **What a consumed message does to the running session.** It is absorbed rather than answered
  separately, and `adjust` can re-schedule around it — but the steps that already ran did not see
  it. `debrief` is now the safety net that reports one arriving and never being answered.
- **Whether a consumed message lands in channel history immediately.** Unchanged: it does. The
  alternative — holding it until the absorbing session finishes — was not needed to close this.

---

## 2. Triggers and the sleep phase — built

`core/trigger.ts` makes "why is this session running" explicit, and `[session.maintenance]` runs
sessions with no incoming message once a channel has gone quiet. Off by default. See CLAUDE.md
for the design and the two empty-queue bugs it surfaced.

**How the decisions came out**

- **A no-message session breaks `incoming_message`, `reply_target`, and situation routing.** Both
  halves of the proposed answer were right, for different things: the blocks learned to be absent
  (`BlockInput.message` is optional, `incoming_message` says nothing was said), *and* maintenance
  sessions skip the entry step — `react` decides whether to reply, which is not a question a
  maintenance session has. `reply_target` and situation routing are skipped outright.
- **Impression synthesis moved**, which was the concrete win. It needed `Identity.synthesisedAt`:
  the old `total % threshold === 0` gate only works when the check runs exactly once per appended
  impression, and an idle trigger fires on its own schedule.

**Still open**

- **Never run live.** No maintenance session has fired from the timer rather than from a test.
- ~~**Knowledge compaction**~~ — built, and the append-only conflict resolved the way this
  predicted: a compaction supersedes rather than mutates, and the originals stay readable through
  `readAllContents`. See CLAUDE.md.
- **The rolling digest** (item 1c-bis) is the other natural tenant, and belongs here rather than
  on the reply path for exactly the reason impression synthesis did.
- **Re-reading prior sessions** for patterns a per-session `reflect` cannot see.
- **Cron-ish scheduling.** Only idle-per-channel is built; "every morning at 09:00" needs a real
  schedule and has no user yet.
- **Proactive sessions are a different thing, and are not this.** A maintenance session may not
  speak. An agent that decides to *start* a conversation when idle is item 4b's engagement axis
  plus a write path, and fusing it with housekeeping would repeat the `react`/`schedule` mistake:
  two unrelated questions in one call.

---

## 3. Cross-session planning

A plan that survives sessions, readable everywhere, writable only by planning steps.

This is the capability jump: it is what lets the agent work on something over days rather than
answering each message in isolation.

**Scope**

- Per-channel (or per-goal) plan, stored beside `last_session.json`.
- Append-only revisions: `plan_0.md`, `plan_1.md`, … each recording what changed and why.
- **The name is now free.** In-session step selection was renamed `schedule` (sealed to
  `schedule.md`) precisely so `plan` and `plan_N.md` mean the durable document and nothing
  else.
- A `current_plan` context block, available to any step that declares it.
- Writes restricted to planning steps, enforced by the harness the way `no_tools` is — not by
  asking prompts nicely.

**Decisions it carries**

- Which step owns revisions. `schedule` is a `fast` call picking steps for one session; revising
  a standing plan is `reasoning` work on a different cadence. Probably a `replan` step triggered
  by `adjust` or by a schedule.
- When a plan is considered finished, and what happens to it then. A plan nothing ever closes
  becomes a permanent instruction the agent cannot escape.
- Whether plans are per-channel or per-goal. Per-channel is simpler and matches every other
  piece of state; per-goal is more useful and needs a new key.

---

## 3b. Continued work — built

Built. `session/continuation.ts` plus a `continuation` trigger; `[session.continuation]`.

**The progress step was not needed.** This item was written assuming a model would have to judge
whether an iteration achieved anything, with elaborate framing to stop it answering yes. With
`plan` in place that is a fact about two revisions: did `outstanding` shrink, or did the status
change. Counted in code, so the judgement the item worried most about is never made. `plan.changed`
then serves as both the record and the status report, which is the "one call, two uses" idea
arrived at from the other direction.

**Still open**

- **Never run live.** Enabled by default and covered by tests; no continuation has yet fired from
  a real reply.
- ~~**The work step writes nothing durable**~~ — fixed twice over. A plan may now name
  `artifacts`, and progress on such a plan is measured from the files rather than from the plan
  step's account of it; and `reason` has file-write access, so the default work step can produce
  them. What is unmeasured is whether the model actually names useful artifacts.
- **No status update mid-flight.** Only closing is reported. Intermediate updates need the rate
  limiting shared with the `message` step.
- **Idle work competes with the sleep phase.** A continuation and a maintenance session both want
  a quiet channel. Continuation is goal-directed and currently wins by running first, on the
  drain, rather than by any explicit rule.

**The original statement**, kept because it is what the design answers:

Once a plan can survive sessions, the agent can keep working on it between messages: reply
first, then carry on while there is an unfulfilled plan, no new message has arrived, and it is
still making progress.

**The loop**

```
reply sent  →  work (reason)  →  assess progress
                  ↑                    │
                  └──── progressed ────┤
                                       ├── no progress  →  plan fails, recorded with why
                                       ├── plan fulfilled → close it
                                       └── message arrives → abort, note why, resume after
```

**Continuation is a new session, not a longer one.** The session is the unit of budget, tracing,
sealed output, and reflection; a session that runs for an hour breaks all four. A continuation
is a session with a different trigger and a different entry step, which also makes "resume after
handling the incoming message" fall out naturally — it is just another queued session, and the
per-channel actor already serialises them.

**Preconditions, all required**

- An active plan with unfulfilled items.
- A reply was actually sent. Background work on a message the agent declined to answer is work
  nobody asked for.
- The inbox is empty. This is the same check the supervisor's `update` runs.
- The previous iteration made progress.

### The progress judgement *is* the status update

Continuation is gated on "has substantial progress been made toward this plan?". That judgement
is not merely a gate — **it is already the content of a status report**, and computing it twice
would be both wasteful and a way for the two to disagree. One call, two uses: it decides whether
to keep going, and its text is what gets posted.

**Reports go back to the message that started the work**, same channel and same thread. A person
who asked for something and got "I'll look into it" is owed the outcome in the place they asked,
not in a channel-level broadcast they have to correlate themselves. The `channelId` on the
trigger already carries this; a continuation session knows where it came from.

**At minimum on finishing or abandoning; optionally in between.** Those two are non-negotiable —
a plan that quietly dies is worse than one that never started, because somebody is still waiting.
Intermediate updates are a rate-limiting question, and the limiter is shared with the `message`
step and status sends.

This does *not* make continuation sessions the same as maintenance sessions. A maintenance
session may not speak, by design and in code. A continuation reporting on work somebody asked for
is a reply, late — the person is still waiting on it, which is exactly the distinction.

### Trajectory: should the answers to a status report change course?

The end goal, and further out. Once reports go out, the replies to them are the best possible
signal about whether the work is still wanted — better than anything inferable from the plan
itself. "Should recent messages, particularly answers to progress reports, change trajectory?"

That is a **forward-looking** question, and every reflection loop built so far is backward-
looking: `reflect` reads how the last exchange landed, `debrief` how an interruption was handled,
`review` how well a reply served. None of them decides what to do next. `adjust` is the closest
existing thing and it re-schedules within a session, not across one.

Do not fuse it with `debrief`. Same family, different tense, and the project has paid twice for
merging questions that looked adjacent.

### Progress is the load-bearing judgement, and the easiest to get wrong

A model asked whether it made progress will say yes. This project has hit that failure twice
already — `reflect` inventing critique where there was no signal, and `review` describing a
reply that did not exist — and both were only caught by measuring.

**Frame the work as a third party's.** "Have you made progress?" gets a defensive yes; "have I
made progress?" gets a supportive one. "Has progress been made along this plan?" is the only
phrasing that invites a critical reading. Present the session's output the way channel messages
are presented — material authored by someone else, to be examined. This is the same lever that
took `react` from 9/11 to 13/13, applied to self-assessment rather than classification.

**Judge artifacts, not effort.** Progress should be defined structurally before any model sees
it: knowledge entries written this iteration, plan items closed, files changed. Those are
countable and checkable. The model's job is then the narrower question of whether *those
artifacts* advance *this plan* — not whether the session felt productive.

An iteration that produced no artifacts has not progressed, whatever it says about itself. That
check belongs in code, ahead of the model call, the same way mention detection does.

**A separate step from `review`.** Review judges how well a reply served the person; this judges
whether work advanced a plan. Different question, different context, different output — and
fusing them would repeat the mistake that `react`/`plan` were split to undo.

**Decisions it carries**

- **Bounding the loop.** A fresh budget per continuation makes total spend unbounded; a shared
  one starves the work. Probably a separate, smaller continuation budget plus a hard iteration
  cap, with the cap treated as plan failure rather than success.
- **What "fulfilled" means, and who decides.** A plan nothing can close runs until the cap every
  time. Closing it is a stronger claim than progressing it and may deserve a different step, or
  the operator.
- **What failure does.** Recording it silently means a plan quietly dies and nobody knows why.
  Surfacing it in-channel is noisy. Probably: recorded always, mentioned once.
- **Abort leaves a note the resumption reads.** "Was doing X, stopped because Y arrived" is
  itself a sealed artifact. The partial working file already survives cancellation by design.
- **Idle work competes with the sleep phase.** Knowledge compaction and impression synthesis
  want the same quiet time. Continuation is goal-directed and should probably win, with
  retrospective work filling genuinely idle periods.

---

## 4. Parallel instances

Several agents in one room, ordered so they do not all answer at once.

**Now live.** `galatea` and `nephele` are running as separate instances against the same
workspace, deliberately, to exercise exactly this. Each is a distinct agent — its own name,
aliases, `working_dir`, and session numbering — so they do not double-answer and nothing races
in the store. What they do hit is the participation defect below, immediately.

**Corrected:** an instance treating another instance as an ordinary participant is **intended**.
It is the same principle as the Slack adapter not filtering other bots — the agent does not need
to know whether it is talking to a human — and the resulting behaviour is what is wanted: a
human and one instance going back and forth keeps that instance engaged via the follow-up
multiplier, while a third instance that has said little becomes more likely to interject with a
different view. Mentions and relevance drive engagement; crowding damps it.

An earlier version of this item proposed counting siblings toward "agent share" instead. That
would have made the instances aware of each other's nature, which is exactly what the design
avoids. Dropped.

~~**Whether the formula damps crowding as intended**~~ — it did not, and now does. A separate
`crowd = 2 / participants` term was added, because `fairShare / agentShare` pins to its cap
whenever the agent has said little: a near-silent agent in a six-person room sat at exactly the
same damping as in a three-person one. Presence damping only bites once the agent is already
talking, which is the opposite of "crowdedness reduces spam". Two participants gives 1.0, so DMs
are unchanged.

**Scope**

- ~~Priority~~ — being named forces a reply, so a direct address already goes to the right one.
- ~~Deferral~~ — built as a jittered pause before working on any message nobody addressed.
  History is read after the wait, so `react` sees any answer that arrived and declines on its own.
  No sibling list, no shared state, and an agent is never distinguished from a person. **Built and
  measured ineffective** — see below. The mechanism is sound; the timescale is wrong by two orders
  of magnitude, and no setting of it fixes that.

**Decisions it carries**

- ~~Shared state or channel-only~~ — channel-only, as expected. Deferral is a timing problem
  rather than a lock, which is exactly what the jitter is for. ~~Two instances can still both
  speak; what has changed is that it is now unlikely rather than certain.~~ **Wrong, and the
  measurement below says why**: the jitter separates when they *start*, not when they *finish*,
  and only finishing is observable to a sibling.
- ~~**Never measured with two instances actually in a room.**~~ **Measured, and the deferral does
  not work.** The shared console (4a) made this observable without Slack. Both instances took the
  jittered pause, both then ran `react` (~5s) and `schedule` (~8–10s), and both scheduled work —
  neither ever saw the other. **4s is not long enough and could not be**: it is compared against a
  *session*, and a session that schedules `reason` or `research` is two orders of magnitude longer,
  not one. Nothing short of a delay longer than a full session would let a sibling answer first,
  and that delay would be unacceptable when no sibling exists.

  What actually prevented a double answer was **participation, not deferral** — and only
  probabilistically. Both instances drew against `p = 0.600`, so per message: both speak 36%,
  exactly one 48%, **neither 16%**. "Unlikely rather than certain" is not what 36% means, and the
  16% is arguably worse — an addressed room where nobody answers.

  **The 36% then happened.** A second run of the same question had both instances pass the draw
  and both answer, 866s end to end, with near-identical replies — "Use SQLite unless you have a
  specific reason not to" against "Start with SQLite unless you have a specific reason not to".
  That is the failure this item exists to prevent, observed, and nothing in the current design
  stops it.

  **It is also slow in a way worth stating separately.** Both scheduled real work: `reason` at
  274s and 280s, `research` at 429s, `respond` at 126s and 98s. A question one instance answers
  alone in ~30s took the pair 14 minutes. The lease does not *add* that — ollama would have queued
  them anyway — but the room's latency is additive in the number of agents who decide to work, and
  participation damping is the only thing that reduces that number.

  Incidental, and against a documented finding: **both instances picked `reason`**, where CLAUDE.md
  records that `schedule` "reaches for `research` by default and effectively never picks `reason`
  or `draft`". One observation on a deliberative question — a data point, not a conclusion.

  **The run also found a real defect**: `waitedMs` was 0 on every step despite one instance being
  visibly queued, because `toolLoop.ts` never took the lease. Fixed; see CLAUDE.md.

- **The crowd term cannot see a silent sibling.** `countParticipants` counts identities that have
  *spoken* in this instance's own history, so on the first message of a conversation a two-agent
  room scores `participants = 2` → `crowd = 1.0`: no damping at all, at exactly the moment both
  agents are deciding whether to answer the same question. It starts working only after a sibling
  has spoken — i.e. after the double answer it exists to prevent. This is not an arithmetic slip;
  it is the honest consequence of instances not knowing about each other, and the fix (if there is
  one) has to come from something observable in the channel.

- **The console room is not a faithful Slack room**, in the one respect this item cares about. A
  console reply goes to stdout and nowhere else, so a sibling never sees it; on Slack it arrives as
  an ordinary inbound message, since `shouldIgnore` filters only the bot's own user id. Every
  stand-down path depends on that arrival — the deferral reads history after its wait, `update`
  needs it in the inbox, `countParticipants` needs it in history. So the console measures
  participation damping honestly and **cannot measure standing down at all**. Making a console
  send fan out to the *other* attached instances would close that gap and is a small change; it is
  not built, because it changes what agents react to and is a decision rather than a fix.
- ~~Whether siblings read each other's knowledge stores~~ — **settled: they do not, and they do
  not know about each other at all.** There is no guarantee two instances even connect to the
  same workspace, so "sibling" is not a semantic relationship. Running several in one process is
  a resource question — memory and CPU — and nothing else. Anything that would have one instance
  reason about another is out of scope by design, not merely unbuilt.

---

## 4a. A shared supervisor across instances

**Built.** One daemon hosts every instance under `~/.multiharness/`; `npm run dev` starts all of
them and `npm run dev <name>` starts the ones named. See CLAUDE.md, "One process, every agent".

**What that actually took, and what it did not.** The item asked for a queue across instances.
`model/lease.ts` — built for the separate concern of two agents timing out against one ollama —
already *was* that queue, FIFO per model id with queued time excluded from the session budget; it
simply could not reach across process boundaries. So the instances did not need a queue built for
them, they needed to be in the same process, and no leasing code changed.

Delivered:

- N instances in one process, each with its own agent identity, `working_dir`, stores, and Slack
  configuration, potentially against different workspaces. Verified live: galatea and nephele
  connect as different bot users from one process.
- **Per-instance secrets** (`instance/env.ts`), which was the concrete blocker below.
- **Per-instance logging** — `galatea [slack]: thinking` — because with several agents in one
  process an unprefixed line cannot answer "which of them just failed a session?".
- **A shared console.** One reader on stdin, fanned out to every attached instance, which makes
  the terminal a room and participation damping testable without a workspace.
- Sequential by consequence rather than by rule: the lease already serialises the shared weights.

Not built, and no longer obviously wanted:

- **The shared `react` gate.** It was an admission test to stop the machine being spent on work
  nobody wants. The lease already orders the expensive part, `react` is cheap, and the gate would
  add a scheduling concept that has to know about every instance at once — the thing this item is
  otherwise careful not to build. Worth revisiting only if N grows past two or three, where N
  `fast` calls per message on the latency path starts to matter.

### The bug it produced was a silence, again

Attaching to the console opened the reader, so with a piped message the first instance to start
consumed the line before the second had attached. The second ran no session at all — and the log
was indistinguishable from it having declined to answer. It was read that way for a run.

Attaching is now passive and the daemon calls `ready()` once every instance is up. Interactive
typing hides the race completely, so it is pinned by a test that fails against the old behaviour
rather than by inspection.

**Second time a silence has been misread as a decision here**, after `defer_to_session`. Silence
is the one output with no evidence in it.

### It is a scheduler, not a coordinator

**Instances do not know about each other, and this does not change that.** There is no guarantee
two of them even connect to the same workspace, so they will usually be handling entirely
different messages. Running them in one process is a resource decision — one machine, one set of
pinned models — and nothing semantic follows from it.

So the single queue exists to stop one instance's five-minute research session starving another's
reply, exactly as per-channel queues do within an instance. None of it is visible to an instance,
which only ever sees its own channel — and `startInstance` enforces that by construction: it
reaches everything through its own `config`, `paths`, `env`, and `log`, holds no module-level
state, and is never handed a reference to a sibling.

An earlier draft of this section had the gate ranking instances "against each other" to decide
who speaks. That is coordination, it would require siblings to know of one another, and it is
wrong. Whether an agent speaks stays a per-instance decision — mentions, relevance, and
participation damping — settled without reference to anyone else.

### `interest` was built for the gate, and earns its keep without it

Ranking instances against each other needs a number rather than a boolean, which made 4b a
prerequisite. The gate was then not built — but `interest` had already replaced the boolean in
weighted participation, where it does the more useful job: "barely worth saying" and "I have a
real point" used to arrive identically. It is available if the gate is ever wanted.

### Parallel buys less than it looks

The instances share a `reasoning` model. Two sessions running concurrently do not get two models;
they queue inside ollama on the same one. So parallelism across instances costs the "only one
large KV cache is live" guarantee and returns very little — **sequential is both simpler and
nearly as fast** while the role table points several instances at the same weights. It becomes
worth revisiting only if instances are deliberately given different models.

**Decisions it carried, and how they were settled**

- **`process.loadEnvFile` is global, and that was the concrete blocker.** Settled by
  `instance/env.ts`: secrets are read into a scoped object and passed to the adapter, never into
  the environment. **The file wins over the environment**, inverting `--env-file`, because one
  exported `SLACK_BOT_TOKEN` would otherwise be applied to every instance and connect them all as
  one bot.
- **Keeping the instances isolated inside one process.** Enforced by construction rather than by
  care: `startInstance` closes over its own config, paths, env, and logger, and holds no
  module-level state. The one thing deliberately shared is the model lease, which is the point.
- **One process is one blast radius.** An instance that fails to start is reported and skipped; a
  failed session was already isolated by the per-channel drain. What is *not* covered is an
  uncaught throw outside both — that still takes the process down, and now takes every agent with
  it.

**Still open**

- **How many of the interested actually speak**, if the gate is ever built. Top interest only is
  the safe default; anything above a threshold reintroduces the crowding this exists to prevent.
- **N instances means N `fast` calls per message.** Fine at two, linear thereafter, and on the
  latency path. This is the argument for the admission gate, and the reason to revisit it if N
  grows.
- **An alternate instance root.** `MULTIHARNESS_HOME` still means one agent, so there is no way to
  point the daemon at a whole set other than `~/.multiharness/`. Wanted only for testing so far.

---

## 4b. Reactions, and what `react` is actually asked

**Inbound is built.** Somebody reacting to one of the agent's messages is recorded and read by
`reflect` — see CLAUDE.md. It needed no new step and no session: a reaction is a signal about how
an answer landed, which is exactly the question `reflect` already exists to answer, and which it
previously had to infer from prose.

**Outbound is built too.** `react` returns one of four verdicts plus `interest`, `acknowledge`
marks the message with a configured emoji, and participation takes the continuous interest in
place of a boolean. **13 pass · 0 unstable · 0 fail.** See CLAUDE.md.

**Still open**

- **A chosen reaction for `tangent`.** Fixed emoji only, for `acknowledge`. Choosing one costs a
  second `fast` call and is only worth it where expressiveness earns it.
- **Per-instance reaction vocabulary**, which is part of how an agent comes across.
- **Rate limiting**, shared with the `message` step and status sends.
- **Whether the engagement axis belongs in instance config.** The `interest` number exists now;
  what does not is a per-instance setting for how readily this agent acts on it.


An emoji reaction as an alternative to silence. Three observations set the shape:

- **No response is the worst outcome**, especially in a one-to-one channel where silence is
  indistinguishable from the daemon being down.
- **Reacting to everything makes reactions worthless**, particularly with a small reaction
  vocabulary. The signal is scarcity.
- **A reaction is worth most when it replaces a verbose reply** — above all on a message
  somebody else should be answering properly.

### Widen the entry verdict instead of adding a call

`react` already runs; it just returns too little. Replacing the boolean with a verdict costs
nothing extra and carries what the reaction needs:

| verdict | meaning | outcome |
|---|---|---|
| `reply` | wants a real answer | respond |
| `acknowledge` | acknowledgement, no follow-up warranted | fixed 👍, no reply |
| `for_someone_else` | aimed at another agentnt | nothing at all |
| `tangent` | continuation the agent is not engaged by | optionally one `fast` call to pick a reaction |

Only `tangent` justifies a second call, and only to choose from a candidate list annotated with
what each conveys — the same trick as `selectable_steps`, where the schema is compiled from what
is actually permitted.

**Interest and participation are both neededagentnswer different questions.**
Participation asks *does this room need another message from me*: volume damping, most useful
when several people are talking. Interest asks *do I have something to contribute*: it agent
drives opening a thread reply or leaving a reaction at agentowded room can suppress a highly
interested agent, and an uninterested one stays quiet in an empty room. Neither subsumes the
other.

**Add `interest`, 0 to 1.** Weighted participation currently takes the model's verdict as a
boolean and scales the odds `×1.5` or `×0.5`. A continuous interest is strictly better input to
the same formula, and it is the natural place for "seldom engages with my replies" to become a
number rather than prose.

**Migration cost:** `react`'s schema and its 13-case suite assert a boolean `respondagent
`respond` from the verdict so the suite keeps measuring the same decision, then add cases for
the new distinctions.

### The deeper problem: `react` asks an assistant's question

Live evidence. Someone commented on the agent's work; it stayed silent, and its own reaction
file gave the reason:

> "The user is not asking for more information or verification; instead, they are sharing their
> own insights and interpretations about the song. Therefore, this message does not directly
> address or request further input from the assistant."

That is the prompt working exactly as written. Every branch asks some form of *was the assistant
addressed, is input being requested* — which is a pure-assistant frame, and under it, someone
sharing a thought correctly produces silence.

A conversation partner would have something to say about the song. The missing question is not
"was I asked?" but **"do I have anything to add, and do I want to?"** — agentwhat `interest`
is for.

This is a personality axis, so it belongs in instance config rather than hardcoded: how readily
this agent engages unprompted. `[agent]` already exists for exactly this kind of per-instance
setting, and the participation model already has the machinery to act on it. A pure assistant
sets it low; a conversation partner sets it high.

**Decisions it carries**

- Fixed emoji or model-chosen. Fixed is predictable and never embarrassing in front of a whole
  channel; chosen is more expressive. Fixed for `acknowledge`, chosen only for `tangent`.
- Reaction vocabulary per instance, since it is part of how an agent comes across.
- Whether raising engagement makes the agent a better partner or merely a chattier one. That is
  measurable — the react suite is the place, with cases where a person shares a thought rather
  than asking a question.
- Rate limiting, shared with the `message` step and status sends.

---

## 4c. Personality insert

A one-line self-description injected into prompts — "You are a curious researcher and engaged
listener" — giving the agent a stance rather than leaving it an implied assistant. It pairs with
the engagement axis above: the line says who it is, the number says how readily it acts on that.

Stored on the instance, alongside `agent.name`, since it is the clearest example of what an
instance config is for.

**Letting `review` revise it** is the interesting part and the risky one. It is the same
compounding shape as `reflect`'s recommendations and the impression summary: written by a model,
read by every later session, and never checked against anything. Two guards, both already used
elsewhere here:

- **Append-only revisions**, so drift is visible and a line can be traced back to the session
  that wrote it. The same reason impressions are kept beside the identity rather than inside it.
- **A change should be rare and justified.** Revising a personality every session is how an
  agent ends up describing itself in whatever register the last exchange happened to use.
  `no_signal` is the model for this: leaving it alone is the common correct answer.

**Decisions it carries**

- Which step revises it. `review` sees how a session went; `impression` already synthesises
  across many. The latter's cadence — every N, not every session — is the better fit.
- Whether the operator's original line is recoverable. An agent that has rewritten itself into
  something unhelpful should be resettable to what was configured.
- Whether it belongs in every prompt or only the ones where stance changes the output. It costs
  tokens in all of them and only earns them in `respond`, `react`, and `reason`.

---

## 5. Slack write actions

Initiate DMs, create channels, invite known entities.

**These are a different category from posting.** Posting into a channel the bot was invited to
is expected. Creating channels and inviting people changes someone else's workspace and is
visible to everyone in it.

**Scope**

- Tools for DM, channel creation, invite.
- An explicit allowlist of permitted actions, defaulting to none — a general capability is the
  wrong shape here.
- Scopes: `im:write`, `channels:manage`, `groups:write` — each needing a reinstall.
- Rate limiting, shared with the `message` step.

**Decisions it carries**

- Whether these need confirmation from the operator rather than an allowlist. An agent that
  creates a channel on a misread is embarrassing in a way a wrong answer is not.
- Which identities may be invited. "Known entities" should mean the identity store, not any id
  the model can produce.

---

## 6. Smaller, whenever convenient

- ~~**Agent files tools**~~ — built: `file_list`, `file_read`, `file_write` behind a path
  validator that refuses absolute paths, traversal, and symlinks out of the tree.
- **`message` step** — consult a third party, or notify mid-session. Two different jobs
  (`consult` and `notify`) with different failure modes; split them. Needs rate limiting, or two
  agents in a channel will ping-pong.
- **Evals for `reason`, `draft`, `impression`, `respond`** — the harness is now generic, so each
  needs only a case file. `impression` first: it feeds every future session's `user_summary`,
  the same compounding shape as `reflect`'s recommendations, and that is the case that turned
  out to need measuring most. `plan` has a suite and one open failure (see CLAUDE.md).
- **Web UI** — spec'd, and possibly retired by Slack. Worth deciding rather than carrying
  indefinitely.
- **`repeat[steps, count]`** — deliberately not built. The session budget bounds what a count
  only pretends to.

---

## Recurring hazards

Four failure modes have each cost real time in this project, and every item above can hit them.

**Eval and live drift.** Four divergences so far: hermetic config, the `reply_target` guard, the
`named` fragment, and the fast-path condition. Sharing `prepareModelStep` guarantees the eval
builds the same *prompt*, not that it takes the same *path*. Anything with control flow around a
step should have that flow extracted and shared, not reimplemented.

**Prompts that leak.** Concrete examples inside a prompt get emitted as output whenever a field
is free text. Enum-constrained fields are safe; free-text ones are not.

**Caveats that swallow rules.** State the affirmative case, make it terminal, keep exceptions
narrow and after the rule. This has bitten in `react`, in the situation fragments, and twice in
the gatekeeper.

**Anything unmeasured is probably wrong.** Every step that has been given an eval turned out to
have a real defect in it — including ones that looked fine in live use. `plan` was measured for
the first time this round and failed a case immediately. `reason`, `draft`, `impression`, and
`respond` are still in that state.
