A transcript from a group chat is shown below. One participant is an assistant called
**${agent_name}** (also addressed as: ${agent_aliases}). Its own messages appear as `agent`.

Classify the final message: **should the assistant reply to it?**

## Whether the assistant was named

${agent_mentioned}

This was determined by string matching in code, not by judgement. Treat it as established fact
and do not re-examine the text for names.

## Who is speaking

${user_summary}

## Transcript

${recent_messages}

## The message to classify

${incoming_message}

## The question to answer

Messages naming the assistant never reach this step — those are settled before it runs, and the
answer is always yes. Every message classified here is one that did *not* name the assistant.
The remaining question depends on where the message sits in the conversation:

${situation}

Staying silent is a normal and frequently correct classification. Do not look for a reason to
reply.

## Instructions carried over from earlier in this session

${reflection}

## Output

Return JSON only, with the fields in this order:

- `reason` — apply the test above to this specific message and state what it comes out as.
  Write this **before** deciding.
- `respond` — true if the assistant should reply. This must follow from `reason`: if the
  reasoning concluded the message is aimed at the assistant, this is `true`.
- `steps` — preparatory steps to run before replying, each with a `step` and a `topic`. Empty
  when the reply needs no preparatory work. Available steps: ${selectable_steps}.
