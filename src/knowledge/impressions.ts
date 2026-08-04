import type { DatabaseSync } from "node:sqlite";
import { IDENTITY } from "./db.ts";
import {
  appendContent,
  createEntry,
  findEntry,
  readContents,
  type ContentBlock,
  type Provenance,
} from "./store.ts";

/**
 * Impressions of a communication partner: what they seem to want, how they
 * react, whether depth is appreciated or merely tolerated.
 *
 * Kept beside the identity rather than inside it. The identity record is a
 * stable reference — id, names, aliases — while impressions accumulate one
 * exchange at a time and are only ever appended. A running opinion that
 * overwrote itself would lose the evidence it was built from, and the agent
 * would have no way to notice it had drifted.
 *
 * These entries live in their own namespace, so the research gatekeeper's
 * shortlist is never polluted with people's names, and they bypass the
 * gatekeeper entirely: there is no topic to choose, because the topic *is* the
 * person.
 */

/** One entry per identity, topic-keyed by identity id. */
function entryFor(db: DatabaseSync, identityId: string, displayName: string) {
  const existing = findEntry(db, IDENTITY, identityId);
  if (existing) return existing;
  return createEntry(
    db,
    IDENTITY,
    identityId,
    `Impressions of ${displayName}`,
    undefined,
    { session: "bootstrap", step: "identity" },
  );
}

export function appendImpression(
  db: DatabaseSync,
  identityId: string,
  displayName: string,
  impression: string,
  provenance: Provenance,
): void {
  const text = impression.trim();
  if (text === "") return;
  appendContent(db, entryFor(db, identityId, displayName).id, text, provenance);
}

export function readImpressions(db: DatabaseSync, identityId: string): ContentBlock[] {
  const entry = findEntry(db, IDENTITY, identityId);
  return entry ? readContents(db, entry.id) : [];
}

/** How many impressions have accumulated, for deciding when to synthesise. */
export const impressionCount = (db: DatabaseSync, identityId: string): number =>
  readImpressions(db, identityId).length;
