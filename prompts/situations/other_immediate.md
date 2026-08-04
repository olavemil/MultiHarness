This message names **${mentioned_other}**, and it comes directly after something the assistant
said.

That combination is the ambiguous one. It could be:

- asking ${mentioned_other} about what the assistant just said — the assistant is being
  *talked about*, not addressed
- redirecting the assistant's point to them for a second opinion — again about it, not to it
- asking the assistant something *concerning* ${mentioned_other} — addressed to the assistant
  after all

**Which is it?** Check who the verb is aimed at. `@${mentioned_other} can you check this?` asks
them. `do you think ${mentioned_other} would agree?` asks the assistant.

Reply only in the last case. Being the subject of a sentence is not being asked a question.
