/**
 * Whether a reply the agent is about to write may name anybody in it.
 *
 * **The second half of the mention-loop fix, and the more general half.**
 * `steps/verdict.ts` stops a bare acknowledgement from *compelling* an answer;
 * this stops the answer, when there is one, from compelling the next.
 *
 * The loop needs both ends. A reply that names somebody is a reply that forces
 * a reply — `core/mentions.ts` matches the name in code and the harness treats
 * it as settled — so an agent with little to say that names the person it is
 * answering has started a conversation neither of them wanted. Seen live with
 * two instances in one channel.
 *
 * Settled here rather than left to the prompt's judgement, in keeping with the
 * rest of the entry path: whether the agent has anything to add is already a
 * number, and "may this reply name anybody" is a threshold on it. The prompt is
 * told the answer, not asked for one.
 *
 * It is guidance rather than enforcement, and deliberately so. The alternative
 * is stripping names out of a finished reply, which cannot be done safely:
 * `detectMention` matches the bare name as well as the `@handle`, so removing
 * the mention means removing the word, and a sentence with a word cut out of it
 * is worse than an unwanted notification.
 */

export interface MentionPolicy {
  /** False when the reply should name nobody. */
  allowed: boolean;
  /** How it is stated to `respond` and `draft`, as `${mention_policy}`. */
  text: string;
}

const ALLOWED =
  "@mention somebody only where the reply genuinely needs their attention — a question put to " +
  "them, or something they have to act on. Answering the person who just spoke to you is not " +
  "one of those: they already know you are talking to them, and naming them obliges them to " +
  "answer you back.";

const REFUSED =
  "**Do not @mention anybody in this reply, and do not address anybody by name.** You have " +
  "little to add here, so this reply should close the exchange rather than hand it on. Naming " +
  "somebody obliges them to answer, and an exchange kept alive that way is one nobody chose.";

/**
 * `interest` is the `stance` step's own measure of how much the agent has to
 * add. Absent when the step could not run, which reads as permitted — the same
 * lean toward normal behaviour every other fallback on this path takes.
 */
export function mentionPolicy(
  interest: number | undefined,
  minInterest: number,
): MentionPolicy {
  const allowed = interest === undefined || interest >= minInterest;
  return { allowed, text: allowed ? ALLOWED : REFUSED };
}
