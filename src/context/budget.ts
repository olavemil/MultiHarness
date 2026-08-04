/**
 * Token budgeting for context blocks.
 *
 * The estimator is deliberately crude. Budgets exist to protect answer quality —
 * local attention degrades well before the nominal window — not to avoid running
 * out of memory, so being off by 15% costs nothing. Swap in a real tokenizer
 * behind `estimateTokens` if that ever stops being true.
 */

const CHARS_PER_TOKEN = 4;

export type KeepEnd = "head" | "tail";

const MARKER = "[… truncated …]";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface Truncation {
  text: string;
  truncated: boolean;
  estimatedTokens: number;
}

/**
 * Trims `text` to fit `maxTokens`, cutting on line boundaries where it can so a
 * block does not end mid-word.
 *
 * `keep: "tail"` retains the end — correct for message history, where the most
 * recent lines matter most. `keep: "head"` retains the beginning, which suits
 * step output whose conclusion comes first.
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  keep: KeepEnd = "head",
): Truncation {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) {
    return { text, truncated: false, estimatedTokens: estimated };
  }

  const budgetChars = Math.max(0, maxTokens * CHARS_PER_TOKEN - MARKER.length - 1);
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of keep === "tail" ? [...lines].reverse() : lines) {
    const cost = line.length + 1;
    if (used + cost > budgetChars) break;
    kept.push(line);
    used += cost;
  }

  // A single line longer than the whole budget leaves nothing; fall back to a
  // hard character cut so the block is trimmed rather than emptied.
  if (kept.length === 0) {
    const cut =
      keep === "tail" ? text.slice(text.length - budgetChars) : text.slice(0, budgetChars);
    const joined = keep === "tail" ? `${MARKER}\n${cut}` : `${cut}\n${MARKER}`;
    return { text: joined, truncated: true, estimatedTokens: estimateTokens(joined) };
  }

  const body = (keep === "tail" ? kept.reverse() : kept).join("\n");
  const result = keep === "tail" ? `${MARKER}\n${body}` : `${body}\n${MARKER}`;

  return { text: result, truncated: true, estimatedTokens: estimateTokens(result) };
}
