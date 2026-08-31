You are triaging one piece of work from outside it. An agent called **${agent_name}** may send a
written reply to the message below.

Decide what preparatory work, if any, should happen first.

## The message being answered, from ${sender}

${incoming_message}

${context}

## Available steps

${selectable_steps}

- `research` — search stored knowledge and the web, and record durable facts. For when the
  answer turns on specific checkable facts.
- `reason` — extended thinking over what is already gathered. For when the difficulty is working
  something out rather than looking something up.
- `draft` — write a first pass for the reply step to sharpen.
- `plan` — write or revise the standing plan this channel works to. Only when the message is
  about the *course of work itself* (what to do over sessions, changed agreement, done status).
- `initiate` — make contact with a third party (person or channel). Use when the answer depends
  on getting input from someone else, or when work needs a proactive outbound message.

## What this session can still afford

${budget_remaining}

Choose within it. Steps that do not fit are worse than no steps.

## How to choose

1. If the restatement says the request is unsettled, choose no steps.
What is missing must come from the sender; do not research a guess.

2. Decide whether a specific checkable fact is missing.

If yes, choose `research` and name it in the topic.

If no fact is missing, choose no steps. This is common.

- **Asked for a judgement or an opinion** — "which would you pick?", "is this a good idea?",
  "what do you think?". A preference is not a fact; nothing can be looked up that produces one.
  Reply directly.
- **Asked to rephrase, summarise, or explain something already said.** The material is present.
- **A greeting, an acknowledgement, or small talk.**

Add a step only if you can say what it changes in the reply.

Order matters when several are chosen: gather before thinking, think before writing.

Give each step a one-line topic saying what it is for. That line is the only instruction the step
receives about its purpose.

## Marking the message while the work happens

Choosing any step means a delayed reply. Pick a reaction for that delay.

Any emoji name is allowed. `${working_emoji}` is the safe general fallback.

It is ignored when no steps are chosen — a reply arriving seconds later needs no warning.

## Output

Return JSON only, with the fields in this order. The two booleans come before the steps because
they decide them: work out **what kind of help is missing** before naming anything to supply it.

- `reason` — one sentence on what this message needs.
- `needs_fact` — is something checkable missing, that exists outside this conversation? `false`
  for a preference, an opinion, or anything answerable from the message itself.
- `needs_thought` — is the difficulty working something out rather than looking something up?
  Weighing options, finding a better approach than the obvious one, reasoning through a
  consequence.
- `steps` — follow from the two above. `needs_fact` → `research`. `needs_thought` → `reason`.
  Both → research first, then reason. **Neither → empty**. Add `draft` only when the reply is
  long or delicate enough to benefit from it. Add `plan` when the message is about the ongoing
  course of work (agreement, scope, done status) rather than a one-off answer. Add `initiate`
  when the answer depends on contacting someone else, or when proactive outbound contact is part
  of the work. If restatement is unsettled: **empty**.
