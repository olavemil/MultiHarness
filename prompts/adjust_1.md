An assistant called **${agent_name}** is part-way through answering a message. Some preparatory
work has finished, and something that arrived since suggests the remaining plan may no longer
fit. Decide what should still happen before it replies.

## The message being answered

${incoming_message}

## Recent messages in this channel

${recent_messages}

## What has been done so far

${prior_step_output}

## Instructions carried over from earlier in this session

${reflection}

## What the session can still afford

${budget_remaining}

## Available steps

${selectable_steps}

- `research` — look something up, in the knowledge store or on the web.
- `reason` — work something out from what is already gathered.
- `draft` — write a first pass for the reply step to sharpen.

## How to decide

**Read what has already been done before adding to it.** The commonest right answer is that
enough has been gathered and the reply should be written now — repeating work that is already
finished is the failure this step exists to prevent, not the one it exists to enable.

Add a step only when the finished work has left a specific gap you can name, and the budget
above can cover it. A gap you cannot name is not a gap.

## Output

Return JSON only, with the fields in this order. The two booleans decide the steps: work out
what is still missing before naming anything to supply it.

- `reason` — one sentence on what the finished work leaves outstanding.
- `needs_fact` — is something checkable still missing that exists outside this conversation?
- `needs_thought` — does something still need working out rather than looking up?
- `steps` — what should run before the reply. **Empty is the common answer**, and means reply
  now with what is in hand.
