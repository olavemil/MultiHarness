import type { Reading } from "./read.ts";
import type { Stance } from "./stance.ts";

/**
 * What the session does about the arriving message.
 *
 * **Derived, never decoded.** `react` decoded this directly, which meant a model
 * chose between four outcomes while the facts that determine them — was the
 * agent named, what is the message asking, of whom, and does the agent have
 * anything to add — were each established separately anyway. The four outcomes
 * are a function of those facts, so they are computed here.
 *
 * That follows the rule the rest of the harness already runs on: mention
 * detection is code because a model reads `@dana can you look at this` and
 * concludes it was addressed; standing is code because three prompt revisions
 * and a decoded boolean all failed at it. This was the last routing question on
 * the entry path still being answered by a prompt.
 */
export type Verdict = "reply" | "acknowledge" | "for_someone_else" | "tangent";

/**
 * Four outcomes rather than a boolean, because "was the agent addressed?" is an
 * assistant's question: under it, somebody sharing a thought correctly produces
 * silence, which is a real failure seen live. The last three are how silence is
 * spelled, and distinguishing them is what lets the harness mark a message
 * instead of ignoring it.
 *
 * **Being named no longer forces a written reply, and that is a fix for a loop
 * seen live.** Two instances in a channel named each other in messages that
 * asked nothing — `@nephele good point` — and a mention bypasses every damping
 * term the system has: `responseProbability` returns a forced 1.0 and takes no
 * draw. Each agent was therefore compelled to answer an acknowledgement, and
 * each answer named the other. Nothing in the system could stop it, because
 * every mechanism that could was disabled by exactly the condition that started
 * it.
 *
 * What a mention still guarantees is that the message is **not ignored**: it
 * either gets an answer or gets marked. That is the property mention detection
 * exists to protect, and it survives intact.
 */
export function deriveVerdict(args: {
  /** Settled by `core/mentions.ts` before either entry step runs. */
  mentioned: boolean;
  /** Absent only when `read` could not run at all. */
  reading?: Reading | undefined;
  stance: Stance;
  /**
   * Interest at or above which the agent speaks up unprompted. `[session]
   * min_interest`.
   */
  minInterest: number;
}): Verdict {
  const reading = args.reading;

  // No reading at all. Answering is the safe default for the same reason
  // `read`'s own fallback wants an answer: a harness problem that produces
  // silence is indistinguishable, to the person waiting, from being ignored.
  if (!reading) return "reply";

  // **A question is answered whoever asked it and however little the agent has
  // to add.** This gate is above the interest test on purpose: letting a low
  // score silence a direct question would reintroduce the exact failure mention
  // detection exists to prevent — somebody asks, and gets an emoji.
  if (reading.wants === "answer") return "reply";

  // Addressed and wanting nothing back — thanks, a confirmation, a decision
  // reported. Marked rather than answered, and never damped: an emoji does not
  // crowd a channel, and damping it leaves the person with nothing at all.
  if (reading.wants === "acknowledgement") return "acknowledge";

  // Nothing is being asked of anybody — a statement, a remark, an exchange
  // between other people. A conversation partner may still have something worth
  // saying about it, and `stance` is the only thing that knows whether this one
  // does. Being named lowers no bar here: the agent was mentioned in passing,
  // not asked, so speaking is worth it on the same terms as anyone else.
  if (args.stance.interest >= args.minInterest) return "reply";

  // Named, but with nothing asked and nothing to add. An acknowledgement is the
  // honest answer and it is what breaks the loop: it responds, so nobody is
  // ignored, and it puts no name in a channel, so nothing is compelled to
  // answer it back.
  if (args.mentioned) return "acknowledge";

  return reading.addressee === "other" ? "for_someone_else" : "tangent";
}

/** Whether the verdict calls for a written answer. The single definition. */
export const wantsReply = (verdict: Verdict): boolean => verdict === "reply";
