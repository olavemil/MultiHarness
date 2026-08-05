import type { Config } from "../config/schema.ts";
import type { Plan } from "../store/planStore.ts";

/**
 * Whether to carry on working after a reply, and whether the last iteration
 * achieved anything.
 *
 * **Progress is counted, not judged.** The roadmap proposed a step that assessed
 * its own progress, with careful third-person framing because a model asked
 * whether it made progress says yes. Once `plan` exists that step is
 * unnecessary: an iteration either closed an outstanding item or it did not, and
 * that is a fact about two plan revisions. This project's rule is that countable
 * facts are settled in code — the same reason mentions are matched rather than
 * judged — and here it removes the single most defensive judgement in the whole
 * design.
 *
 * It also collapses "the progress judgement is the status update" into something
 * simpler than one call with two uses: `plan.changed` is written once by the
 * step that revises the plan, and is both the record and the report.
 */

export interface ProgressDelta {
  progressed: boolean;
  /** Outstanding items closed by this iteration. Negative if the plan grew. */
  closed: number;
  /** Declared artifacts that appeared or grew. */
  artifactsChanged: number;
  /** True when the plan reached `fulfilled` or `abandoned`. */
  finished: boolean;
}

/**
 * Compares the plan before and after an iteration.
 *
 * Closing the plan counts as progress whichever way it closed: abandoning a plan
 * that turned out to be wrong is a result, not a failure to report.
 */
export function progressBetween(before: Plan | undefined, after: Plan | undefined): ProgressDelta {
  // `loadPlan` returns nothing for a closed plan, so `after` being absent while
  // `before` was present means this iteration closed it.
  const finished = before !== undefined && after === undefined;
  if (finished) {
    return {
      progressed: true,
      closed: before.outstanding.length,
      artifactsChanged: 0,
      finished: true,
    };
  }
  if (!before || !after) {
    return { progressed: false, closed: 0, artifactsChanged: 0, finished: false };
  }

  const closed = before.outstanding.length - after.outstanding.length;
  const artifactsChanged = countArtifactChanges(before, after);

  // **When a plan names artifacts, they are the ground truth.** Closing an item
  // is the plan step's own account of what it did; a file appearing or growing
  // is not. An iteration that produced no artifacts has not progressed, whatever
  // it says about itself — the roadmap's wording, and the reason the artifact
  // list exists at all.
  //
  // A plan that names none is deliberative rather than productive, so there is
  // nothing to measure and the closed count is all there is.
  const progressed = after.artifacts.length > 0 ? artifactsChanged > 0 : closed > 0;
  return { progressed, closed, artifactsChanged, finished: false };
}

/** Artifacts that came into existence, or got bigger, between two revisions. */
function countArtifactChanges(before: Plan, after: Plan): number {
  const previous = new Map(before.artifactState.map((a) => [a.path, a]));
  return after.artifactState.filter((now) => {
    const then = previous.get(now.path);
    if (!now.exists) return false;
    if (!then?.exists) return true;
    return now.size > then.size;
  }).length;
}

export interface ContinueInput {
  config: Config;
  plan: Plan | undefined;
  /** Whether the session that just ran actually sent something. */
  replied: boolean;
  /** Messages waiting for this channel. Anything queued outranks background work. */
  pending: number;
  /** Which iteration the *next* one would be, from 1. */
  nextIteration: number;
  /** What the iteration that just ran achieved. Absent after a reply session. */
  delta?: ProgressDelta | undefined;
}

/**
 * All the preconditions, in one place, each returning why it said no.
 *
 * Returns the reason to continue, or `undefined`. Reported either way so a
 * continuation that does not happen is explicable — a background loop that
 * silently declines to run is indistinguishable from one that is broken.
 */
export function shouldContinue(input: ContinueInput): string | undefined {
  const { enabled, max_iterations } = input.config.session.continuation;
  if (!enabled) return undefined;

  // Work on a message the agent declined to answer is work nobody asked for.
  if (!input.replied) return undefined;
  if (!input.plan || input.plan.outstanding.length === 0) return undefined;

  // Anything waiting outranks background work, and the arrival may change the
  // plan anyway. The continuation is dropped rather than queued behind it: once
  // that message is answered, its own session decides whether to continue.
  if (input.pending > 0) return undefined;

  // A cap rather than a judgement. Reaching it is plan failure, not success —
  // the plan is left active and simply stops being pushed, so the next real
  // exchange can revive or close it.
  if (input.nextIteration > max_iterations) return undefined;

  // An iteration that closed nothing has not progressed, whatever it says about
  // itself. Stopping here is what stops a plan being ground at forever.
  if (input.delta && !input.delta.progressed) return undefined;
  if (input.delta?.finished) return undefined;

  const items = input.plan.outstanding.length;
  return `${items} item${items === 1 ? "" : "s"} still outstanding on "${input.plan.goal}"`;
}
