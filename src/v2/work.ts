import { compose } from "./compose/section.ts";

/**
 * The background work list.
 *
 * **The v1 problem this exists for.** v1 has three background mechanisms —
 * maintenance, continuation, and curiosity pursuit — and every gate in all
 * three is a *countable fact* decided by the harness: is a threshold crossed,
 * has a question resurfaced N times, did the last iteration close an item.
 * That was a deliberate and largely correct choice, because the alternative was
 * asking a model "have you made progress?", which always answers yes.
 *
 * But it has a consequence nobody designed: **the agent never decides to do
 * anything.** It performs housekeeping when a counter says housekeeping is due.
 * The one place where something like intent could enter — curiosity — only
 * pursues a question after it has resurfaced twice by embedding similarity, and
 * the questions themselves are harvested mechanically from step output.
 *
 * So v2 splits the decision from the accounting:
 *
 * - **What to work on is proposed by a step**, `schedule_work`, which is asked
 *   at the end of every session what is worth doing next. That is a genuine
 *   judgement and belongs in a prompt you can tweak.
 * - **Whether it runs, and how often, stays countable here.** Attempt caps,
 *   deduplication, and yielding to messages are facts, not judgements.
 *
 * The judgement is the part that was missing; the accounting is the part v1 got
 * right and this keeps.
 */

/** What kind of work an item asks for. Bounded, so it reads as bounded. */
export const WorkKind = {
  research: "research",
  reason: "reason",
  write: "write",
  contact: "contact",
} as const;
export type WorkKind = (typeof WorkKind)[keyof typeof WorkKind];

export interface WorkItem {
  kind: WorkKind;
  /** What to do, in the agent's own words. Merged on collision. */
  task: string;
  /** Where it came from, so a stale item can be traced to the session that proposed it. */
  origin: { session: string; channelId: string; at: string };
  /**
   * How many times this has been attempted.
   *
   * Countable, and the only thing standing between "work on it until it is
   * done" and an item that can never finish. Not a judgement about progress —
   * see the note at the top of this file about why that question is not asked.
   */
  attempts: number;
}

export interface WorkList {
  items: WorkItem[];
}

export const emptyWorkList = (): WorkList => ({ items: [] });

/**
 * Adds proposed work, merging into an existing item of the same kind.
 *
 * **Merging is by concatenation**, from restructuring.md:
 *
 *     (research:"Do task 1") + (research:"Do task 2")
 *       = (research:"Do task 1\nDo task 2")
 *
 * Deliberately chosen over v1's embedding-similarity merge for curiosities.
 * That one carries an unmeasured threshold — `merge_threshold = 0.6`, and the
 * usable band is specific to the embedding model — whereas grouping by kind has
 * no constant in it at all and cannot merge two things that are actually
 * different questions.
 *
 * An item that has already been attempted is left alone rather than absorbing
 * new text, so its attempt count keeps meaning attempts at *that* task.
 */
export function addWork(list: WorkList, proposed: readonly Omit<WorkItem, "attempts">[]): WorkList {
  const items = list.items.map((i) => ({ ...i }));

  for (const item of proposed) {
    const task = item.task.trim();
    if (task === "") continue;

    const existing = items.find((i) => i.kind === item.kind && i.attempts === 0);
    if (existing) {
      if (!existing.task.split("\n").includes(task)) existing.task = `${existing.task}\n${task}`;
      continue;
    }
    items.push({ ...item, task, attempts: 0 });
  }

  return { items };
}

export interface DrainPolicy {
  /**
   * Attempts before an item is dropped.
   *
   * The closing rule. v1's `plan` earned `fulfilled`/`abandoned` because a task
   * list nothing can close becomes a standing instruction the agent cannot
   * escape — read into every idle period for ever. This is the same guard in
   * its cheapest form: a count, not a judgement.
   *
   * Generous on purpose. A machine that can afford to sit and think all day
   * should try a hard thing several times before giving up on it; what it must
   * not do is try one thing an unbounded number of times and never reach the
   * rest of the list.
   */
  maxAttempts: number;
}

/**
 * The next item to work on, or nothing.
 *
 * **Messages always win.** `hasPendingMessages` is checked here rather than
 * trusted to the caller because this is the one rule that makes background work
 * safe to run indefinitely: an agent that is thinking must still answer the
 * door. v1 gets this from the per-channel drain; v2 keeps it explicit.
 */
export function nextWork(
  list: WorkList,
  policy: DrainPolicy,
  hasPendingMessages: boolean,
): WorkItem | undefined {
  if (hasPendingMessages) return undefined;
  return list.items.find((i) => i.attempts < policy.maxAttempts);
}

/** Records an attempt, dropping the item once it is out of them. */
export function recordAttempt(list: WorkList, item: WorkItem, policy: DrainPolicy): WorkList {
  const items: WorkItem[] = [];

  for (const current of list.items) {
    if (current !== item) {
      items.push(current);
      continue;
    }
    const attempts = current.attempts + 1;
    // Dropped rather than kept at a cap, so the list does not accumulate
    // exhausted items that every later sweep has to skip past.
    if (attempts < policy.maxAttempts) items.push({ ...current, attempts });
  }

  return { items };
}

/** Removes an item the agent reported finished. */
export function completeWork(list: WorkList, item: WorkItem): WorkList {
  return { items: list.items.filter((i) => i !== item) };
}

/** The work list as a prompt section, or nothing when it is empty. */
export function describeWork(list: WorkList): string | undefined {
  if (list.items.length === 0) return undefined;

  return compose(
    list.items.map((i) => [
      `- **${i.kind}**${i.attempts > 0 ? ` (attempted ${i.attempts}×)` : ""}`,
      ...i.task.split("\n").map((line) => `  ${line}`),
    ]),
  );
}
