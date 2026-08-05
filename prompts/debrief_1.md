A session has just finished in a group chat. While it was working, other people said things.
The record of that session is below. Judge how it dealt with what came in.

The work is somebody else's. Read it as material to examine, not as your own conduct to account
for — the point is to find what was missed, and that is only visible to a critical reading.

## The message the session set out to answer

${incoming_message}

## What arrived while it was working

${mid_session_messages}

## What the session produced

${prior_step_output}

## What it did, and how long it took

${session_summary}

## What to look for

**Was anything asked that nobody answered?**

This is the question that matters. A message can arrive mid-session, be noticed, and then be
lost: the session was already committed to a different task, it finished that task, and it
stopped. Nothing downstream notices, and the person who asked is left waiting for a reply that
was never coming.

Check each arriving message against what the session produced. An arrival is answered if the
session's output actually addresses it — not merely if the session was aware of it. Being
noticed and being answered are different things, and the gap between them is what to report.

Some arrivals need no answer from *this* session, and those are not omissions:

- **Anything left for a session of its own.** The record above says so for each message. A
  session that carried on past an arrival, or stopped because of one, did not take it on — it is
  still queued and will be answered there. Reporting it here raises an alarm about a message
  already in hand, and the note is stale before anyone reads it.

Judge as unanswered only what this session **took on**: the messages it re-scheduled around or
cut its work short to reply to. Those are the ones nothing else will pick up.
- A remark between two other people.
- An acknowledgement, or a thank-you.
- A comment on something already covered by what the session produced.

**Was cutting the session short the right call, when it was cut short?**

The record above says whether it was. A session stopped for something genuinely more urgent was
handled correctly. A session stopped for a passing remark abandoned work that was wanted, and a
session that ploughed on through something urgent got it wrong the other way.

Say which happened. Do not soften it — this is the only look anything ever takes at those
decisions, so a generous reading here means the same mistake is made next time.

## What to carry forward

One line, only when the next session in this channel genuinely needs it: a question still owed
an answer, or a subject the conversation moved to while the session was busy.

Leave it empty otherwise, which is the common case. Anything written here is read by the next
session and acted on, so an invented note sends it after something nobody asked for.

## Output

Return JSON only, with the fields in this order:

- `assessment` — two or three sentences on what came in and how the session dealt with it. Work
  it out here, before listing anything.
- `unanswered` — one entry per arriving message that asked something and did not get an answer,
  written as the question still owed. Empty when everything was dealt with.
- `carry_forward` — one line for the next session, or empty.
