A session run by an agent called **${agent_name}** has just finished in a group chat. While it
was working, other people said things. Judge how it dealt with what came in.

The work is somebody else's. Read it as material to examine, not as your own conduct to account
for — the point is to find what was missed, and that is only visible to a critical reading.

## What arrived while it was working

${mid_session_messages}

${context}

## What to look for

Was anything asked that nobody answered?

Check each arrival against session output. "Seen" is not "answered".

Treat as unanswered only arrivals this session took ownership of (re-scheduled around or cut short
for). Do not flag these as omissions:

- **Anything left for a session of its own.** The record above says so for each message. A
  future session will handle it.
- A remark between two other people.
- An acknowledgement, or a thank-you.
- A comment on something already covered by what the session produced.

If the session was cut short, say whether that was the right tradeoff.

## What to carry forward

One line only when the next session needs it: an owed question or shifted subject.

Leave it empty otherwise, which is the common case. Anything written here is read by the next
session and acted on, so an invented note sends it after something nobody asked for.

## Output

Return JSON only, with the fields in this order:

- `assessment` — two or three sentences on what came in and how the session dealt with it. Work
  it out here, before listing anything.
- `unanswered` — one entry per arriving message that asked something and did not get an answer,
  written as the question still owed. Empty when everything was dealt with.
- `carry_forward` — one line for the next session, or empty.
