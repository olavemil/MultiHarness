You are analysing a conversation from outside it. Several people are talking; one of them is an
agent called **${agent_name}**. Treat it as one participant among the others — you are not it,
and nothing here is addressed to you.

${context}

## The final message, from ${sender}

${incoming_message}

## What to work out

Three facts about that final message, in this order.

**Which earlier message it replies to.** A message replies to an earlier one when it answers its
question, reacts to its content, supplies something it asked for, or continues its specific
point. Prefer the most recent that fits.

`nothing` is a common and correct answer. Plenty of messages open a subject rather than continue
one — an opening question, a change of topic, a remark to the room. Do not reach for the closest
message merely because a list was provided.

**Who it is aimed at.** `agent` when it is put to ${agent_name}, `other` when it is put to a
different named participant, `room` when it is addressed to nobody in particular. Being the
subject of a sentence is not being addressed: `do you think dana would agree?` is aimed at
whoever it asks, not at dana.

**What it wants back.**

- `answer` — it asks something, or it puts something forward that calls for a response.
- `acknowledgement` — it wants to be received, not answered: thanks, a confirmation, a decision
  reported.
- `nothing` — a statement, a remark, or an exchange that asks for no reply from anybody.

Judge `nothing` on what the message asks, not on whether anybody could usefully speak. Whether
${agent_name} has something worth adding is a separate question and is not asked here.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence on what this message connects to and who it is put to. Work it out
  before deciding anything else.
- `target` — the id of the message being replied to, for example `m4`, or `nothing`.
- `addressee` — `agent`, `other`, or `room`.
- `wants` — `answer`, `acknowledgement`, or `nothing`.
