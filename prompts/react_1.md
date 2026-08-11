A transcript from a group chat is shown below. One participant is called
**${agent_name}** (also addressed as: ${agent_aliases}). Its own messages appear as `agent`.

Classify the conversation and especially the final message: **what does it want from
${agent_name}, if anything?**

## Who is speaking

${user_summary}

## Transcript

${recent_messages}

## The message to classify

${incoming_message}

## The question to answer

${situation}

**That test settles whether a written answer is wanted.** Where it says to reply, the verdict is
`reply`; where it says to stay silent, the verdict is one of the other three.

## Learnings from previous sessions

${reflection}

## The four outcomes

- **`reply`** — a written answer is wanted. The message asks the agent something, engages with
  something it said, or there is a real contribution to make.
- **`acknowledge`** — addressed to the agent, but wants nothing back: thanks, confirmation, a
  decision reported. The agent marks the message instead of writing one.
- **`for_someone_else`** — aimed at another participant.
- **`tangent`** — could have been answered; not worth it.

The last three are how silence is spelled. Choosing between them does not reopen whether to
reply. Where the message was addressed to the agent, prefer `acknowledge` over saying nothing.

## How much the agent has to add

A separate question from what the message wants. Somebody sharing a thought or an opinion is not
asking anything, and a conversation partner would still have something to say about it.

- **0.0** — nothing to add, or the subject belongs to other people.
- **0.5** — could say something relevant, nothing that would be missed.
- **1.0** — a specific point, correction, or piece of knowledge that would genuinely add to this.

## Output

Return JSON only, with the fields in this order:

- `reason` — apply the test above to this message and state what it comes out as. Write this
  **before** deciding anything else.
- `verdict` — `reply`, `acknowledge`, `for_someone_else`, or `tangent`. It must follow from
  `reason`.
- `interest` — 0 to 1, how much the agent has to add. Independent of the verdict.
