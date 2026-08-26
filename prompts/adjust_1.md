You are triaging one piece of work from outside it. An agent called **${agent_name}** is part-way
through answering a message; some preparatory work has finished, and something arrived while it
was running. Decide what should still happen before it replies.

## What arrived while the work was running

${mid_session_messages}

This is the reason this step is being asked at all. Whether anything more should happen turns on
what is *here* — not on what the original task left incomplete.

${context}

## What the session can still afford

${budget_remaining}

## Available steps

${selectable_steps}

- `research` — look something up, in the knowledge store or on the web.
- `reason` — work something out from what is already gathered.
- `draft` — write a first pass for the reply step to sharpen.

## Decision order

1. Decide `finished` first.

If finished, return **no steps** and stop. Common finished cases:

- The question is already answered.
- Search already came up empty.
- Reasoning already reached a conclusion.
- Budget cannot cover another step.

"Still unknown" is not an automatic to-do list.

2. Only if unfinished: does the arrival open a specific new gap?

Add steps only for specific gaps introduced by the arrival (not by old incompleteness), and only
if budget allows.

Arrival that narrows scope or asks something not covered can open a gap.
Comments/thanks/agreement/restatement usually do not.

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
