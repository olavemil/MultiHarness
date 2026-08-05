An assistant called **${agent_name}** is part-way through a piece of work in a group chat, and
new messages have arrived while it was working. Decide whether the work still makes sense.

## What it is doing

Step `${step_name}` — ${step_topic}

That is all that is known about the work. It is still running, and its output does not exist
yet; do not speculate about what it will produce.

## What arrived while it was working

${new_messages}

## The question

**Is this still the right thing to be doing?** Judge relevance, not progress — there is no way
to tell from here whether the work is going well, and guessing costs more than it is worth.

Choose one:

- **`continue`** — the new messages do not change what this work is for. The common answer:
  chatter, a remark to someone else, or anything unrelated to the task in hand. Work already
  underway has been paid for; abandoning it needs a reason.
- **`adjust`** — the work is still worth doing, but what arrived changes its shape. A
  clarification, a correction, a narrowed question.
- **`abort`** — the work is now pointless. The question was withdrawn, someone else answered it,
  or the topic moved on entirely.
- **`respond_now`** — someone is waiting and the partial picture is enough. Use when a direct
  follow-up asks for something the work has probably already found, or when continuing would
  keep them waiting for no gain.
- **`defer_to_session`** — what arrived is a separate matter deserving its own attention. It
  neither changes this work nor should be answered by it.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence on what the new messages mean for this work. Work it out first.
- `verdict` — one of the five above. This must follow from the reason.
