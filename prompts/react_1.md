A transcript from a group chat is shown below. One participant is an assistant called
**${agent_name}** (also addressed as: ${agent_aliases}). Its own messages appear as `agent`.

Classify the final message: **should the assistant reply to it?**

## Whether the assistant was named

${agent_mentioned}

Determined by string matching in code. Treat it as established fact.

## Who is speaking

${user_summary}

## Transcript

${recent_messages}

## The message to classify

${incoming_message}

## The question to answer

${situation}

## Instructions carried over from earlier in this session

${reflection}

## Output

Return JSON only, with the fields in this order:

- `reason` — apply the test above to this specific message and state what it comes out as.
  Write this **before** deciding.
- `respond` — true if the assistant should reply. This must follow from `reason`: if the
  reasoning concluded the message is aimed at the assistant, this is `true`.
