const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface AgentNames {
  name: string;
  aliases: readonly string[];
}

/**
 * Detects whether the agent was named, returning the matched term.
 *
 * Deterministic on purpose. Asking a small model "were you mentioned?" is a
 * string match dressed up as a judgement, and it fails badly — a 3.8B model
 * reads `@dana can you look at this` and concludes it was addressed directly.
 * Settling this in code leaves the prompt one genuinely hard question: whether
 * an unaddressed message still wants an answer.
 *
 * A leading `@` is optional on both sides, so `harness` and `@harness` are the
 * same term. Word boundaries keep `multiharness` from matching `harness`.
 */
export function detectMention(text: string, agent: AgentNames): string | undefined {
  const terms = [agent.name, ...agent.aliases]
    .map((term) => term.trim().replace(/^@+/, ""))
    .filter((term) => term.length > 0);

  for (const term of terms) {
    // `(?!\w)` rather than `\b` on the trailing side: `\b` needs a word
    // character to bound against, so a name ending in punctuation — `c++` — is
    // never matched by it. This still rejects `harnessing`.
    if (new RegExp(`(?:^|[^\\w])@?${escapeRegExp(term)}(?!\\w)`, "i").test(text)) {
      return term;
    }
  }
  return undefined;
}
