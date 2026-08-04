A knowledge store holds short factual entries, each filed under a immutable two- or three-word
topic. A candidate piece of text has been proposed for storage. Decide what should happen to it.

## The candidate

${candidate}

## The closest existing topics

These were selected by embedding similarity, so they are the entries most likely to overlap.
There may be no overlap at all — a short list does not imply a match.

${nearest_topics}

## First: is this about a subject at all?

If the candidate describes what someone said, asked, or plans to do — `olav asked what node
version the project targets`, `the team will revisit this Friday` — **`reject`**. That is
conversation state, not knowledge. Stop there.

The store holds durable facts about subjects, worth retrieving weeks from now by someone who
was not present.

## Then: does it belong under a topic that already exists?

**Default to `append`.** If any topic above covers the same subject, the candidate goes there,
even when it adds a new angle — that is what "more detail" means. `docker networking` absorbs
bridge mode, host mode, NAT behaviour, and how any of them differ on macOS. All of that is one
subject and belongs in one entry.

Name the topic in `existing_topic` and stop there. This is the most common correct answer, and
a store that fragments one subject across four near-identical topics is useless — every future
lookup finds a quarter of what it needs.

## Only if no topic above covers it

- **`new`** — nothing above is about this subject. Propose a `new_topic` of **two or three
  words**, lowercase. `docker networking` is a topic; `notes` is not, and
  `typescript nodejs strip-only mode` is too long — prefer `type stripping`.

- **`collides`** — a topic above is about a genuinely *different* subject that happens to share
  vocabulary, and filing the candidate there would merge two things that must stay apart. Name
  the near-miss in `existing_topic` and give a qualified `new_topic`. This is rare; a shared
  subject with a different angle is `append`, not this.

- **`reject`** — already stated above and adding nothing, or too vague to find later.

## What belongs in the store

Durable facts about subjects, worth retrieving weeks from now. Not conversation state, not
task lists, not restatements of what someone just said.

Rejecting is a normal outcome and does not need justifying at length. A store full of vague
entries is worse than a small one, because the vague entries crowd out the useful ones in every
future lookup.

## Output

Return JSON only, with the fields in this order:

- `reason` — one sentence. Work out which case this is before choosing.
- `verdict` — `append`, `new`, `collides`, or `reject`.
- `existing_topic` — the topic named above that this appends to or collides with, or `none`.
- `new_topic` — the proposed topic for `new` or `collides`; empty string otherwise.
- `summary` — one short line describing what the entry covers, for `new` or `collides`; empty
  string otherwise. This disambiguates topics whose names are close.
