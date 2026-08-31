An agent called **${agent_name}** records the questions it could not settle — things it looked
for and did not find, conclusions that turned on something it did not know, questions somebody
asked that never got answered. They accumulate across every conversation it takes part in, and
when a channel goes quiet the agent goes and works on whichever has come up most.

Nothing removes them except this. Your job is to say which ones are finished with.

## The open questions

${open_curiosities}

Each says how often it has come up and how often the agent has already gone and looked into it.
Both matter, and they matter in opposite directions.

## What to close

Close when it is genuinely spent:

- **It has been answered.** The agent looked, found out, and the question is spent.
- **Looking is not going to settle it.** Something asked several times and investigated several
  times without closing is not waiting on more research. It needs a person, or it is unanswerable
  from here.
- **It was never a real question.** Harvested automatically, so some of these are an aside, a
  passing caveat, or a restatement of something the agent knows perfectly well.
- **It has been overtaken.** The work it came from is done, or the subject moved on.
- **Another entry says the same thing.** Close the vaguer one and leave the sharper.

## What to leave alone

Leaving open is the default. Most should stay open.

Do not close something merely because it is hard, broad, or has been open a long time. Age is not
evidence. A question that keeps coming back is the strongest thing in this list, not the weakest.

Closing everything empties the store and leaves the agent with nothing it wants, which is worse
than a list with some noise in it.

## Output

Return JSON only, with the fields in this order. The reasoning comes first because a list of
closures written first is a decision already made, and what follows it is a rationale rather than
a judgement.

- `reasoning` — one or two sentences on what this list looks like as a whole, and which of it is
  spent. Work it out before naming anything.
- `close` — one entry per question to close, each with the `question` copied **exactly** as it
  appears above, and `why` in a few words. Empty when they should all stay open, which is a
  perfectly ordinary answer.
