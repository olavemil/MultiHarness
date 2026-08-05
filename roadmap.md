# Roadmap

What is left, in the order I would build it. [harness.md](harness.md) is the spec;
[CLAUDE.md](CLAUDE.md) is the conventions and the measured findings. This file is the plan.

Each item carries the design decisions it will actually run into — several of them were
discovered the hard way while building what already exists, and are cheaper to know in advance
than to rediscover.

---

## Where things stand

Built and measured: the session pipeline (`reflect → react → plan → [research | reason |
draft] → respond → summarize → review → [impression]`), the knowledge store with its gatekeeper,
identities with append-only impressions, five tools, CLI and Slack adapters, and three eval
suites (react 13/13, reflect 7/7, gatekeeper 8/8).

Built but unmeasured: `reason`, `draft`, `impression`, `respond`. `schedule` has a suite and one
well-characterised failure: it reaches for `research` by default and effectively never picks
`reason` or `draft` (see CLAUDE.md).

Not built: the supervisor, scheduled triggers, agent-files tools, the `message` step,
cross-session planning, continued work, the web UI.

---

## 1. Supervisor loop — mostly done

Built: the per-channel actor, `update` running alongside steps, verdicts applied at a single
join, and cancellation via `AbortSignal` on `abort` / `respond_now`.

**Still open:**

- **`adjust` does nothing yet.** The verdict is recorded and logged, but nothing revises the
  queue or the plan on it. It wants the cross-session plan (item 3) to have something to revise.
- **`defer_to_session` does nothing yet** — it should enqueue a follow-up session rather than
  being dropped.
- **Concurrent knowledge writes.** The gatekeeper is a read-then-write with no transaction
  around it, so two channels writing the same topic can both decide "new". Introduced by the
  per-channel actor; the unique constraint turns it into an error rather than a duplicate, but
  it is unhandled.
- **Debouncing.** `update` fires whenever the inbox is non-empty at a step boundary. It should
  be debounced and capped at one in flight.
- **No eval suite.** `update` is a `fast` classification with five outcomes and no measurement,
  which by this project's record means it is probably wrong somewhere.

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

## 2. Triggers: scheduled runs and the sleep phase

Spec'd in harness.md ("scheduled run, or other trigger") and never built. Unlocks the deferred
processing idea and the deferral half of parallel instances.

**Scope**

- A trigger interface alongside adapters: something that produces a session without an inbound
  message.
- Scheduled sessions per channel (idle, cron-ish, or "N minutes after the last exchange").
- A session kind that has no incoming message, which several context blocks currently assume.

**The sleep phase**

Idle time is where the expensive retrospective work belongs. Candidates, all currently either on
the critical path or unbuilt:

- **Knowledge compaction** — the dedup and normalisation pass the store was designed for and has
  never had. Entries accumulate; nothing merges or rewrites them.
- **Impression synthesis** — currently queued at session end. It has no reason to be there.
- **Re-reading prior sessions** for patterns the per-session `reflect` cannot see.

**Decisions it carries**

- A no-message session breaks `incoming_message`, `reply_target`, and the situation routing.
  Either those blocks learn to be absent, or scheduled sessions run a different entry step.
- Compaction rewriting knowledge entries conflicts with append-only content. The resolution is
  probably a new sealed revision rather than mutation, keeping the original blocks intact.

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

## 3b. Continued work

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

**The thing to know first:** weighted participation **does not work across instances today**.
`core/participation.ts` counts the agent's own share via `fromAgent`, and instance B sees
instance A's messages as another participant. So B's own share stays low, its damping rises, and
it becomes *more* likely to speak. Both answer. The mechanism that was supposed to prevent
crowding actively causes it.

**Scope**

- Recognise sibling instances as agents rather than participants — a configured list of sibling
  identities, counted toward "agent share" rather than against it.
- Priority: being named already forces a reply, so a direct address goes to the right one.
- Deferral: an instance that is not named waits, sees whether a sibling answered, and stands
  down. Needs the trigger work from item 2.

**Decisions it carries**

- Whether instances coordinate through shared state or purely through the channel. Channel-only
  is simpler, more robust, and fits "the agent does not need to know whether it is talking to a
  human" — but it makes deferral a timing problem rather than a lock.
- Whether siblings read each other's knowledge stores. Sharing makes them one agent with two
  voices; separate stores make them genuinely distinct, and probably more interesting.

---

## 4b. Reactions, and what `react` is actually asked

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
| `for_someone_else` | aimed at another participant | nothing at all |
| `tangent` | continuation the agent is not engaged by | optionally one `fast` call to pick a reaction |

Only `tangent` justifies a second call, and only to choose from a candidate list annotated with
what each conveys — the same trick as `selectable_steps`, where the schema is compiled from what
is actually permitted.

**Interest and participation are both needed — they answer different questions.**
Participation asks *does this room need another message from me*: volume damping, most useful
when several people are talking. Interest asks *do I have something to contribute*: it is what
drives opening a thread reply or leaving a reaction at all. A crowded room can suppress a highly
interested agent, and an uninterested one stays quiet in an empty room. Neither subsumes the
other.

**Add `interest`, 0 to 1.** Weighted participation currently takes the model's verdict as a
boolean and scales the odds `×1.5` or `×0.5`. A continuous interest is strictly better input to
the same formula, and it is the natural place for "seldom engages with my replies" to become a
number rather than prose.

**Migration cost:** `react`'s schema and its 13-case suite assert a boolean `respond`. Derive
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
"was I asked?" but **"do I have anything to add, and do I want to?"** — which is what `interest`
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

- **Agent files tools** — read/write/list/move within `files/`, which exists and is empty.
  Spec'd, self-contained, low risk, and needs a path validator rather than a sandbox.
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
