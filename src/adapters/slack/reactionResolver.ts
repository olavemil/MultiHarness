import { normaliseEmoji } from "../../core/emoji.ts";
import type { ReactionResolution } from "../types.ts";

const FUZZY_MIN_SCORE = 0.82;
const AMBIGUOUS_DELTA = 0.04;
const MAX_AMBIGUOUS = 5;

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }

  return prev[b.length]!;
}

function similarity(query: string, candidate: string): number {
  if (query === candidate) return 1;
  const maxLen = Math.max(query.length, candidate.length);
  if (maxLen === 0) return 0;

  const base = 1 - levenshtein(query, candidate) / maxLen;
  const overlap =
    query.includes(candidate) || candidate.includes(query)
      ? Math.min(query.length, candidate.length) / maxLen
      : 0;

  const prefixBonus =
    query.startsWith(candidate) || candidate.startsWith(query) ? 0.08 : 0;

  return Math.min(1, Math.max(base, overlap) + prefixBonus);
}

function uniqueNormalised(names: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normaliseEmoji(raw);
    if (name) seen.add(name);
  }
  return [...seen];
}

export function resolveReactionName(
  requestedRaw: string,
  availableNames: readonly string[],
): ReactionResolution {
  const requested = normaliseEmoji(requestedRaw);
  if (!requested) return { kind: "invalid", emoji: requestedRaw };

  const available = uniqueNormalised(availableNames);
  if (available.length === 0) return { kind: "unverified", emoji: requested };

  if (available.includes(requested)) return { kind: "exact", emoji: requested };

  const scored = available
    .map((name) => ({ name, score: similarity(requested, name) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top) return { kind: "none", emoji: requested };
  if (top.score < FUZZY_MIN_SCORE) return { kind: "none", emoji: requested };

  const nearTop = scored.filter((entry) => top.score - entry.score <= AMBIGUOUS_DELTA);
  if (nearTop.length === 1) {
    return { kind: "fuzzy", emoji: top.name, score: top.score };
  }

  return {
    kind: "ambiguous",
    candidates: nearTop.slice(0, MAX_AMBIGUOUS).map((entry) => entry.name),
  };
}
