An agent called **${agent_name}** is part-way through answering a message. Some preparatory
work has finished, and something that arrived since suggests the remaining plan may no longer
fit. Decide what should still happen before it replies.

## The message being answered

${incoming_message}

## What arrived while the work was running

${mid_session_messages}

This is the reason this step is being asked at all. Whether anything more should happen turns on
what is *here* — not on what the original task left incomplete.

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

## First: is the work finished?

Answer this before considering anything else, and if it is yes, return **no steps** and stop.
It is yes in all of these:

- **The question has been answered.** The finished work above contains what was asked for. That
  it does not answer every adjacent question is not a reason to continue.
- **The search came up empty.** A step that looked and found nothing will look and find nothing
  again. Running it a second time is the exact repetition this step exists to prevent. Reply
  with what is known, including that it could not be found.
- **The thinking reached a conclusion.** Once there is a conclusion, writing the reply is the
  remaining work, and the reply step does that.
- **The budget above cannot cover another step.** Queuing work that will not fit gets the
  session cut short and the reply written from half-finished work.

**A "Still unknown" list is not a to-do list.** It records what the step could not establish
after trying. Treating each entry as a gap to fill sends the session back to do what it has
already failed at.

## Only if the work is genuinely unfinished

Add a step when the message that arrived — not the old task — has opened a specific gap you can
name in one line, and the budget can cover it. A gap you cannot name is not a gap.

**The test is whether the arrival changed the question.** A message that narrows what is wanted,
or asks about something the finished work does not cover, opens a gap. A message that comments,
agrees, thanks, or restates does not — however incomplete the earlier work looks. Incompleteness
in the finished work is not a reason to add a step; that work already tried.

## Output

Return JSON only, with the fields in this order. `finished` decides the steps: settle whether
anything remains before naming anything to do.

- `reason` — one sentence on what the arrival leaves outstanding, if anything.
- `finished` — `true` when the work above is enough to reply from, including when a search came
  up empty or the budget is spent. **This is the common answer.**
- `needs_fact` — only when `finished` is false: is something *checkable* missing, that exists
  outside this conversation? A version number, what a document says, what an API returns.
- `needs_thought` — only when `finished` is false: is the difficulty working something out from
  what is already gathered? Weighing it up, following a consequence through, judging whether
  something holds. **A question about what the gathered facts imply is this, not a fact.**
- `steps` — **must be empty when `finished` is true.** Otherwise follow from the two booleans:
  `needs_fact` → `research`, `needs_thought` → `reason`. Not both unless both are genuinely true.
