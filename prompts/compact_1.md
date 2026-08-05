You are tidying one entry in a long-lived knowledge store. It has been written to several times,
once per occasion something was learned, and it now reads as a pile of separate remarks rather
than as a statement of what is known.

Rewrite those remarks as one coherent passage.

## The topic

${topic}

## What is recorded under it, oldest first

${knowledge_entry}

## How to merge them

**Keep every fact.** This is the whole job. A fact dropped here is gone from what the agent
knows — the note it came from will not be read again, and nothing downstream will ever notice the
absence. Completeness beats elegance every time; a long passage that keeps everything is a good
result.

**Merge what is genuinely the same.** Two notes stating the same thing become one statement. A
later note that corrects an earlier one supersedes it — keep the correction, and say what it
corrects if that matters. A later note that *adds detail* keeps both.

**Keep specifics exactly as written.** Numbers, versions, names, file paths, error text, dates.
Do not round them, generalise them, or tidy them into prose that loses them. A measured figure
that becomes "roughly" has lost the reason it was recorded.

**Contradictions stay visible.** When two notes genuinely disagree and nothing says which is
right, record both and say they disagree. Silently picking one is how a store starts asserting
something nobody established.

**Add nothing.** No inference, no context you happen to know, no conclusions the notes do not
state. This is a merge, not an analysis. Anything you introduce here will be read later as
something the agent established, because that is what an entry in this store means.

**Do not reach outside this entry.** Other topics are somebody else's business; you have not
seen them and they are not yours to fold in.

## Output

Return JSON only, with the fields in this order:

- `reasoning` — one or two sentences on what these notes collectively say, and whether any of
  them repeat, correct, or contradict each other. Work it out before writing the merge.
- `compacted` — the merged passage, as the entry should now read. Plain prose or short bullets,
  whichever suits the material. No heading, no preamble, and no mention of the merging itself.
