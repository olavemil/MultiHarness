A knowledge store holds short factual entries, each filed under a immutable two- or three-word
topic. A candidate piece of text has been proposed for storage. Decide what should happen to it.

## The candidate

${candidate}

## The closest existing topics

These were selected by embedding similarity, so they are the entries most likely to overlap.
There may be no overlap at all — a short list does not imply a match.

${nearest_topics}

## Decision order

1. Is this a specific, durable fact about a subject?

If not, **reject**. Typical rejects:
- conversation state (who said/asked/decided what)
- plans/tasks (what to do next)
- vague claims too general to retrieve later

2. Does an existing entry already say this?

If it is only a restatement with no new detail, **reject**.

If it adds mechanism, number, caveat, consequence, or other real detail, it is not a duplicate.

Compare against entry content, not just topic names.

3. Does it belong under one of the existing topics?

Default to **append**. If an existing topic covers the same subject, append there.

Set `existing_topic` and stop.

4. Only if no existing topic covers it:

- **`new`** — nothing above is about this subject. Propose a `new_topic` of **two or three
  words**, lowercase.

- **`collides`** — a topic above is about a genuinely *different* subject that happens to share
  vocabulary. Name the near-miss in `existing_topic` and propose a qualified `new_topic`.

- **`reject`** — already stated above and adding nothing, or too vague to find later.

Rejecting is normal.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence. Work out which case this is before choosing.
- `verdict` — `append`, `new`, `collides`, or `reject`.
- `existing_topic` — the topic named above that this appends to or collides with, or `none`.
- `new_topic` — the proposed topic for `new` or `collides`; empty string otherwise.
- `summary` — one short line describing what the entry covers, for `new` or `collides`; empty
  string otherwise. This disambiguates topics whose names are close.
