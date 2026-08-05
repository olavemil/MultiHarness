A transcript from a group chat is shown below, ending with a message that an agent called
**${agent_name}** is going to answer. That it will be answered is already settled and is not in
question here.

Restate that final message as a single self-contained request: what is being asked, written so
that somebody who has not read the transcript would know exactly what to do.

## Transcript

${recent_messages}

## The message being restated

${incoming_message}

## What the last exchange here was taken to mean

${prior_request}

## Whether that reading turned out to be wrong

${request_correction}

**A correction outranks the transcript.** It was written after seeing how the person responded
to the previous answer, which is better evidence of what they want than anything that can be
inferred from the messages alone. When one is present, the reading it gives is the settled one:
build the restatement on it rather than re-deriving a reading of your own.

## First: does the transcript settle what is being asked?

Answer this before writing anything, while the restatement does not yet exist. Once a confident
paragraph has been written it is very hard to notice that it papered over a gap.

**Usually the transcript does settle it.** A reference whose referent is obvious is settled even
when nobody spelled it out, and a request that is merely broad or open-ended is not ambiguous.
Mark it resolved and move on — that is the ordinary answer.

**A correction above settles it too.** Asking again about something the person has just finished
explaining is worse than having asked the first time.

The exception is narrow: **a reference with two or more real candidates in the transcript.** Two
different things were proposed, and the final message points back at "it" or "that" without
saying which. Then report what is open instead of picking one, and do not answer both — a
request covering two proposals is not what was asked either.

A term the participants share and the agent does not is **not** an open point. They know
what it means; it is not ambiguous just because it is unfamiliar.

## Then: what the restatement is for

The steps that do the work receive the restatement in place of the transcript. Anything left
out of it is information they will not have.

**Resolve every reference that points outward.** Pronouns, "this", "that", "the same thing",
"like you did before" — replace each one with the thing it refers to, taken from the transcript.

**Carry every constraint forward.** A constraint is any limit already placed on an acceptable
answer: a language or tool to use, something ruled out, a length, a budget, a requirement to
avoid something. Constraints are frequently stated once, early, and by somebody other than the
last speaker, so read the whole transcript for them rather than the closing lines. A restatement
that quietly drops one is worse than no restatement at all, because it reads as complete.

**Add nothing.** Do not answer the request, do not judge whether it is a good one, and do not
introduce any detail the transcript does not contain. This is a restatement, not an
interpretation.

## Output

Return JSON only, with the fields in this order. Settledness is decided before the restatement
is written, on purpose: judging a paragraph that already reads well is not the same question as
asking whether the transcript answered it.

- `reasoning` — one or two sentences on how the final message and the transcript fit together:
  what it refers back to, and what constrains an acceptable answer.
- `resolved` — `true` when the transcript settles what is being asked, which is the usual case.
  `false` only when a reference genuinely has more than one candidate in the transcript.
- `unresolved` — empty when `resolved` is `true`. Otherwise one entry per open point, each
  written as the question that would settle it.
- `request` — the self-contained restatement, one paragraph at most, describing what is asked of
  the agent. When `resolved` is `false`, restate only the part that is settled and leave the
  open points to the field above rather than covering every candidate.
