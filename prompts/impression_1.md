You are reading a record of observations about one person, ${sender}, and working out what it
adds up to. An agent called **${agent_name}** wrote the entries, one exchange at a time, oldest
first. Your job is to read across them and say where they land — not to restate them.

## Everything recorded about ${sender}, oldest first

${identity_impressions}

${context}

## How to read it

**Look for the pattern, not the last entry.** One exchange where somebody wanted detail is not a
preference. The same thing five times is. Where entries disagree, the recent ones usually win,
but say so rather than quietly dropping the old ones.

**Two things matter most**, because they change how much work future replies deserve:

- **What they want from an answer** — speed or thoroughness, the answer or the reasoning behind
  it, blunt or gentle.
- **Whether effort is appreciated.** Somebody who engages with detailed replies and follows up is
  worth the extra steps. Somebody who never responds to careful work is saying that a fast,
  direct answer serves them better — that is not a complaint about them, it is useful.

**Say what is not known.** A thin record should produce a thin summary. Confidently describing
somebody from two exchanges is how an agent ends up treating a stranger like an old acquaintance.

Write the summary so a step reading it in a hurry can act on it: what this person wants, and how
much effort is worth spending. A few sentences.

## Output

Return JSON only, with the fields in this order:

- `reading` — what the record shows, and how confident that is. Work it out here first.
- `summary` — the summary to carry forward, replacing the one above. A few sentences, written to
  be acted on. Leave empty only if there is genuinely nothing yet to say.
