A transcript from a group chat is shown below. One participant is called
**${agent_name}** (also addressed as: ${agent_aliases}). Its own messages appear as `agent`.

Classify the final message: **what does it want from the ${agent_name}, if anything?**

## Whether the agent was named

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

**That test settles whether a written answer is wanted, and it is the authority here.** Where it
says to reply, the verdict is `reply`. Where it says to stay silent, the verdict is one of the
other three, and the section below picks which — silence there means "no written answer", not
"do nothing at all".

## Instructions carried over from earlier in this session

${reflection}

## The four outcomes

- **`reply`** — a written answer is useful or needed. Anything asking the agent something, and
  anything it has a real contribution to make to. Something engaging with or building upon what the agent wrote.
- **`acknowledge`** — the message is addressed to the agent but wants nothing back. Thanks,
  confirmation, a decision reported. A written reply here is noise; the agent marks the
  message instead.
- **`for_someone_else`** — aimed at another participant. Not the agent's to answer, and not
  its to mark either.
- **`tangent`** — the conversation carries on and the agent has nothing worth adding. Not
  the same as `for_someone_else`: this one *could* have been answered, and is not worth it.

These three are how "stay silent" is spelled. Choosing between them does not reopen the question
of whether to reply — that was settled above.

**Of the three, prefer the ones that leave a trace.** In a one-to-one channel, doing nothing at
all is indistinguishable from being switched off, and `acknowledge` exists so that "nothing to
add" still answers.

## How much the agent has to add

Separately from what the message wants: does the agent actually have something to say here?

This is not "was it addressed" — that is settled above. Somebody sharing a thought, an opinion,
or something they have just worked out is not asking a question, and a conversation partner would
still have something to say about it. Judge whether there is a real contribution to make, and how
much of one:

- **0.0** — nothing to add, or the subject belongs to other people.
- **0.5** — could say something relevant, nothing that would be missed.
- **1.0** — a specific point, correction, or piece of knowledge that would genuinely add to this.

A crowded channel damps this afterwards, in code. Judge the contribution itself and let the
harness decide what to do with it.

## Output

Return JSON only, with the fields in this order:

- `reason` — apply the test above to this specific message and state what it comes out as.
  Write this **before** deciding anything else.
- `verdict` — `reply`, `acknowledge`, `for_someone_else`, or `tangent`. This must follow from
  `reason`: if the reasoning concluded the message is aimed at the agent and wants an answer,
  it is `reply`.
- `interest` — 0 to 1, how much the agent genuinely has to add. Independent of the verdict:
  a `tangent` the agent has a real point about still scores high, and the harness decides
  whether that is enough to speak.
