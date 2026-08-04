A transcript from a group chat is shown below. An assistant called **${agent_name}** is going
to reply to the final message — that is already decided and is not in question here.

Decide what preparatory work, if any, should happen first.

## Who is speaking

${user_summary}

## Transcript

${recent_messages}

## The message being answered

${incoming_message}

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

## How to choose

**Choosing nothing is the common answer.** Most messages can be answered directly, and every
step costs real time — a session with three steps takes minutes where a direct reply takes
seconds. A fast answer beats a marginally better slow one.

Add a step only when you can say what it would change about the reply. If you cannot, it would
not change anything.

Order matters when you choose several: gather before thinking, think before writing.

Give each step a one-line topic saying what it is for. That line is the only instruction the
step receives about its purpose.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence on what this message needs. Work it out before choosing.
- `steps` — the steps to run, in order, each with a `step` and a `topic`. Empty when the reply
  needs no preparatory work.
