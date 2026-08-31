import type { Config } from "../config/schema.ts";
import { KNOWLEDGE, openKnowledgeDb } from "../knowledge/db.ts";
import { compactionCandidates } from "../knowledge/compaction.ts";
import { impressionCount } from "../knowledge/impressions.ts";
import { readNewReactions } from "../store/reactionStore.ts";
import { openCuriosities, type Curiosity } from "../knowledge/curiosity.ts";
import type { Identity } from "../core/types.ts";
import type { Paths } from "../store/paths.ts";
import type { DatabaseSync } from "node:sqlite";

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
  /**
   * The open question this session is going to work on, when it is a pursuit.
   *
   * Carried so the harness can record that it was tried and close it if the work
   * settles it — neither of which the step itself may do, for the same reason no
   * step writes a plan on its own authority.
   */
  curiosity?: Curiosity | undefined;
}

export async function pendingMaintenance(
  paths: Paths,
  config: Config,
  identity: Identity,
  channelId?: string,
  /** Injectable so a test can seed an in-memory store rather than a file. */
  injected?: DatabaseSync,
): Promise<MaintenanceWork | undefined> {
  const { enabled, steps: allowed } = config.session.maintenance;
  if (!enabled) return undefined;

  const db = injected ?? openKnowledgeDb(paths.knowledge);
  try {
    const steps: string[] = [];
    const reasons: string[] = [];

    // **A reaction is the only signal that arrives without anybody speaking.**
    // It was recorded and then read at the start of the next real exchange —
    // which never comes if the reaction *was* the last word, and a channel that
    // goes quiet after a 👎 is precisely where knowing about it matters. The
    // watermark is what makes this schedulable: without it the condition would
    // never stop being true.
    if (channelId !== undefined && allowed.includes(config.session.reflect_step)) {
      const fresh = await readNewReactions(paths, channelId);
      if (fresh.length > 0) {
        steps.push(config.session.reflect_step);
        reasons.push(
          fresh.length === 1
            ? `${fresh[0]?.author} reacted :${fresh[0]?.emoji}: to something the agent wrote`
            : `${fresh.length} new reactions on the agent's own messages`,
        );
      }
    }

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

    // Before the pursuit branch below, and that ordering matters: a store full
    // of stale questions makes the *selection* wrong, so tidying it comes first.
    if (allowed.includes("prune") && config.session.curiosity.enabled) {
      const open = openCuriosities(db);
      // Only once there is enough to be worth reading across. Below that, every
      // entry is young and closing anything would throw away the only thing the
      // agent has to pursue.
      if (open.length >= config.session.curiosity.max_open) {
        steps.push("prune");
        reasons.push(`${open.length} open questions have accumulated`);
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

    // `ponder` rides along with whatever else is happening rather than gating on
    // its own condition. It has no trigger of its own — thinking about your
    // situation is not something that becomes "due" — and giving it one would
    // mean inventing a threshold for how often an agent ought to think.
    if (steps.length > 0 && allowed.includes("ponder")) {
      steps.push("ponder");
    }

    // **Last, and only alongside other work.** Starting a conversation is not
    // itself a reason to wake a channel — a sweep that fired for nothing else
    // and then decided to speak would be an agent looking for an excuse. It
    // rides on a session that was already justified, and the countable gates in
    // `core/initiative.ts` decide whether there is anywhere to speak at all.
    if (steps.length > 0 && allowed.includes("initiate") && config.session.initiative.enabled) {
      steps.push("initiate");
    }

    if (steps.length > 0) return { steps, reason: reasons.join("; ") };

    // **Only once there is nothing to tidy.** Housekeeping is bounded and
    // cheap; pursuing an open question runs `research` on the large weights and
    // may start a plan, so it waits until the quiet is real. It also reads the
    // right way round: the agent puts its affairs in order, and when there is
    // nothing left to put in order it goes and works on what has been bothering
    // it.
    return pursuit(db, config, channelId);
  } finally {
    if (!injected) db.close();
  }
}

/**
 * The open question worth spending idle time on, if any.
 *
 * **Selection is countable, and that is the whole design.** The question is not
 * "what are you curious about?" — a model asked that produces an answer whatever
 * is true, the same shape as "have you made progress?". It is "which of these
 * has come back most often?", which is a fact about the store. A question asked
 * once is a loose end; one asked four times across two channels is something the
 * agent keeps needing and does not have.
 *
 * Scoped to the channel it came from. Pursuit can escalate into a plan, plans
 * are per-channel, and pursuing something in whichever room happened to fall
 * quiet first would file the plan in the wrong place. The *store* stays
 * cross-channel, which is what makes recurrence meaningful: the same question in
 * two rooms is one question that has come up twice.
 */
function pursuit(
  db: DatabaseSync,
  config: Config,
  channelId: string | undefined,
): MaintenanceWork | undefined {
  const { enabled, pursue_after, escalate_after } = config.session.curiosity;
  if (!enabled || channelId === undefined) return undefined;

  const [target] = openCuriosities(db).filter(
    (c) => c.channelId === channelId && c.resurfaced >= pursue_after,
  );
  if (!target) return undefined;

  // **Escalation is countable too.** Something that keeps coming back *and* has
  // survived being looked into is what earns a plan — a commitment later
  // sessions act on unprompted, and far too heavy for a question that has been
  // asked twice and never investigated.
  const escalate = target.resurfaced >= escalate_after && config.session.plan_step !== "";
  const steps = escalate ? ["research", config.session.plan_step] : ["research"];

  return {
    steps,
    reason: target.question,
    curiosity: target,
  };
}
