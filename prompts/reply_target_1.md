Below is a transcript from a group chat. One of the participants is an assistant called
**${agent_name}**; its messages are marked `you`. Ignore that label — you are not that
participant. You are analysing the conversation from outside it.

## Transcript

${message_window}

## The message to analyse

${incoming_message}

## Your task

Work out which earlier message, if any, this last message is a reply to.

A message replies to an earlier one when it answers its question, reacts to its content,
supplies something it asked for, or continues its specific point. Prefer the most recent
message that fits.

**`nothing` is a common and correct answer.** Plenty of messages start a new subject rather
than continue an existing one — an opening question, a change of topic, a remark to the room.
If nothing in the transcript is being replied to, say `nothing`. Do not reach for the closest
message just because a list was provided.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence identifying what in the transcript this connects to, or why it
  connects to nothing. Work it out here first.
- `target` — the id of the message being replied to (for example `m4`), or `nothing`. This
  must follow from what you just wrote.
