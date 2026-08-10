import type { ContextBlock } from "./types.ts";

/**
 * What the agent itself last said here, and how long ago.
 *
 * **The gap it fills.** `reflect` opens a session by judging how the previous
 * one landed — but a session in which the agent declined to reply *is* the
 * previous one, so after a run of declines it reads a review of no reply, a
 * summary with no answer in it, and no `request.md` at all. Everything it has to
 * go on is its own silence, and it starts assessing the incoming message for
 * whether anyone remarked on that silence. Nothing was wrong with any single
 * judgement; the accumulation is simply not how conversations work.
 *
 * So the previous *session* and the last *contribution* are different questions,
 * and only one of them was being asked. This block answers the second, reaching
 * past the message window on purpose: an agent that has been quiet is exactly
 * the case where its last contribution is no longer in view.
 *
 * Second person, because its only reader is `reflect` — a `digest` step doing
 * substantial work, written as the agent doing it.
 */
export const lastContribution: ContextBlock = {
  name: "last_contribution",
  resolve: ({ lastContribution: last }) => {
    if (!last) return "You have not said anything in this channel yet.";

    // **A fallback, not a second copy.** When the agent answered last turn, the
    // previous session's own artifacts already carry that answer, and repeating
    // it here measurably hurt: restating your own reply immediately before being
    // asked "did it land?" primes `satisfied`. `new-subject` and
    // `prior-reflection-carried` both dropped to 2/3, answering `satisfied` for
    // an acknowledgement followed by an unrelated question.
    //
    // So the quote appears only where nothing else supplies it — when the agent
    // has been quiet and the exchange it last took part in has moved out of
    // reach. That is the case this block was added for.
    if (last.messagesSince <= 1) {
      return "You spoke here in the exchange just before this one; the previous session's own output above is that answer.";
    }

    return (
      `You did not speak in the exchange just before this one. The last time you did, ` +
      `${last.messagesSince} messages ago, you wrote:\n\n"${last.text.trim()}"\n\n` +
      `Everything since has been other people talking.`
    );
  },
};
