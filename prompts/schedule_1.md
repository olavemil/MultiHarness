A transcript from a group chat is shown below. An assistant called **${agent_name}** is going
to reply to the final message — that is already decided and is not in question here.

Decide what preparatory work, if any, should happen first.

## Who is speaking

${user_summary}

## Transcript

${recent_messages}

## The message being answered

${incoming_message}

## The same message, restated in full

${request}

This is what the steps below would receive in place of the transcript. It is a restatement, not
a correction — the message above is still what has to be answered.

## Instructions carried over from earlier in this session

${reflection}

## Available steps

${selectable_steps}

- `research` — search stored knowledge and record durable facts. Choose it when the answer
  turns on something specific the assistant would otherwise be guessing at, or on something it
  may already have recorded.
- `reason` — extended thinking over what is already gathered. Choose it when the difficulty is
  working something out rather than looking something up.
- `draft` — write a first pass for the reply step to sharpen. Choose it when the reply is long
  or delicate enough that composing and judging it at once would go badly.

## What this session can still afford

${budget_remaining}

Choose within it. Steps that will not fit are worse than no steps: the session is cut short
and the reply gets written from half-finished work. With little left, answer directly.

## How to choose

**First: does the restatement say the request is not settled by the conversation?** If it does,
choose no steps and stop there. What is missing is something only the person who asked can
supply, and the reply is a question about the open points. Work cannot resolve it, and work done
on a guessed interpretation is work spent on the wrong question.

**Then: is a specific fact missing that the assistant does not have?**

A fact means something checkable that exists outside this conversation — what a document says,
what a version number is, what an API returns. If one is missing, choose `research` and name it
in the topic.

If nothing like that is missing, **choose no steps and stop there.** That is the common
answer, and it covers more than it sounds like:

- **Asked for a judgement or an opinion** — "which would you pick?", "is this a good idea?",
  "what do you think?". A preference is not a fact; nothing can be looked up that produces one.
  Weighing known options is what writing the reply already does.
- **Asked to rephrase, summarise, or explain something already said.** The material is present.
- **A greeting, an acknowledgement, or small talk.**

Every step costs real time — a session with three steps takes minutes where a direct reply
takes seconds. Add a step only when you can name what it would change about the reply. "It
might be useful" is not naming it.

Order matters when you choose several: gather before thinking, think before writing.

Give each step a one-line topic saying what it is for. That line is the only instruction the
step receives about its purpose.

## Output

Return JSON only, with the fields in this order. The two booleans come before the steps because
they decide them: work out **what kind of help is missing** before naming anything to supply it.

- `reason` — one sentence on what this message needs.
- `needs_fact` — is something checkable missing, that exists outside this conversation? A
  document's contents, a version number, what a place or a product actually is. `false` for a
  preference, an opinion, or anything answerable from the message itself.
- `needs_thought` — is the difficulty working something out rather than looking something up?
  Weighing options, finding a better approach than the obvious one, reasoning through a
  consequence.
- `steps` — follow from the two above. `needs_fact` → `research`. `needs_thought` → `reason`.
  Both → research first, then reason. **Neither → empty**, which is the common case. Add
  `draft` only when the reply itself is long or delicate enough to be worth writing twice.
  A request the restatement reports as unsettled → **empty**, whatever the two booleans say.
