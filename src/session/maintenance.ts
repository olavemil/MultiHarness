import type { Config } from "../config/schema.ts";
import { KNOWLEDGE, openKnowledgeDb } from "../knowledge/db.ts";
import { compactionCandidates } from "../knowledge/compaction.ts";
import { impressionCount } from "../knowledge/impressions.ts";
import type { Identity } from "../core/types.ts";
import type { Paths } from "../store/paths.ts";

/**
 * What retrospective work a channel has waiting, if any.
 *
 * The gate lives here rather than inside the session because **a maintenance
 * session with nothing to do is pure cost** — it opens a session directory,
 * spends a digest call, and produces a summary of having done nothing. The same
 * argument keeps `restate` off the declining path.
 *
 * Returns the steps that actually have work plus a reason, which becomes the
 * trigger's reason and every step's topic. No session can appear in `sessions/`
 * unexplained.
 */

export interface MaintenanceWork {
  steps: string[];
  reason: string;
}

export async function pendingMaintenance(
  paths: Paths,
  config: Config,
  identity: Identity,
): Promise<MaintenanceWork | undefined> {
  const { enabled, steps: allowed } = config.session.maintenance;
  if (!enabled) return undefined;

  const db = openKnowledgeDb(paths.knowledge);
  try {
    const steps: string[] = [];
    const reasons: string[] = [];

    if (allowed.includes("impression")) {
      const total = impressionCount(db, identity.id);
      const fresh = total - (identity.synthesisedAt ?? 0);
      // Synthesising every exchange restates the latest observation and calls it
      // a pattern, which is why the threshold exists at all.
      if (fresh >= config.session.impression_threshold) {
        steps.push("impression");
        reasons.push(
          `${fresh} new impressions of ${identity.displayName} since their summary was written`,
        );
      }
    }

    if (allowed.includes("compact")) {
      // Only entries that qualify — three or more live blocks. Counting live
      // blocks rather than all of them is what stops an already-compacted entry
      // qualifying forever.
      const candidates = compactionCandidates(db, KNOWLEDGE);
      if (candidates.length > 0) {
        steps.push("compact");
        const [first] = candidates;
        reasons.push(
          candidates.length === 1
            ? `"${first?.entry.topic}" has ${first?.blocks.length} separate notes under it`
            : `${candidates.length} entries have three or more separate notes; ` +
              `"${first?.entry.topic}" has the most`,
        );
      }
    }

    if (steps.length === 0) return undefined;
    return { steps, reason: reasons.join("; ") };
  } finally {
    db.close();
  }
}
