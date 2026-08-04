A knowledge store holds short factual entries, each filed under a immutable two- or three-word
topic. A candidate piece of text has been proposed for storage. Decide what should happen to it.

## The candidate

${candidate}

## The closest existing topics

These were selected by embedding similarity, so they are the entries most likely to overlap.
There may be no overlap at all — a short list does not imply a match.

${nearest_topics}

## First: is this a specific, durable fact about a subject?

The store holds facts worth retrieving weeks from now by someone who was not present. If the
candidate is not one, **`reject`** and stop there. Three ways it fails that test:

- **Conversation state** — what someone said, asked, or decided. Who wanted what is not a fact
  about a subject.
- **A plan** — what will be done, in what order, next. The store is not a task list.
- **Too general to retrieve** — statements that could sit under almost any topic, or that
  assert something is important, worth considering, or depends on circumstances. If you cannot
  name the specific thing it is a fact *about*, there is no topic to file it under, and nobody
  will ever find it. Reject it rather than inventing a topic to hold it.

Apply this test before anything below. Most candidates that fail it look superficially like
knowledge, because they are written in the same register.

## Second: does one of the topics already say this?

If the candidate restates something an entry above already covers — the same fact in different
words, adding no detail that is not already there — **`reject`**. Stop there.

That is not the same as adding a new angle. A candidate that gives the entry a mechanism, a
caveat, a number, or a consequence it does not already contain is `append`. A candidate that
says what the entry says, reworded, is a restatement — appending it makes the entry longer
without making it say more, and every future read pays for that.

Compare against what the entry above actually states, not against the topic name.

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
