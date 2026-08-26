You are analysing a conversation from outside it. An agent called **${agent_name}** is going to
answer the final message; that it will be answered is settled and is not in question here.

Restate that message as a single self-contained request: what is being asked, written so that
somebody who has not read the transcript would know exactly what to do.

## Transcript

${recent_messages}

## The message being restated, from ${sender}

${incoming_message}

${context}

## First: is the request settled?

Decide this before writing the restatement.

Usually it is settled.

`resolved = false` only when a reference has two or more real candidates in the transcript and the
final message does not disambiguate.

A recorded correction above outranks transcript inference: use that reading.

Unfamiliar shared jargon is not unresolved by itself.

## Then: what the restatement is for

The steps that do the work receive this restatement in place of the transcript. Anything left out
of it is information they will not have.

Resolve outward references (pronouns, "this/that", "same as before") to explicit referents.

Carry all explicit constraints (tools/language, exclusions, limits, budgets, style constraints).

Add nothing beyond transcript/correction content.

## Output

Return JSON only, with the fields in this order. Settledness is decided before the restatement
exists, on purpose: judging a paragraph that already reads well is not the same question as
asking whether the transcript answered it.

- `reasoning` — one or two sentences on how the final message and the transcript fit together:
  what it refers back to, and what constrains an acceptable answer.
- `resolved` — `true` when the transcript settles what is being asked, which is the usual case.
  `false` only when a reference genuinely has more than one candidate in the transcript.
- `unresolved` — empty when `resolved` is `true`. Otherwise one entry per open point, each
  written as the question that would settle it.
- `request` — the self-contained restatement, one paragraph at most, describing what is asked of
  ${agent_name}. When `resolved` is `false`, restate only the settled part and leave the open
  points to the field above rather than covering every candidate.
