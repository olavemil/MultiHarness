import type { ContextBlock } from "./types.ts";

/**
 * What the agent itself last said here, and how long ago.
 *
 * **The gap it fills.** `reflect` opens a session by judging how the previous
 * one landed — but a session in which the agent declined to reply *is* the
 * previous one, so after a run of declines it reads a review of no reply, a
 * summary with no answer in it, and no `request.md` at all. Everything it has to
 * go on is its own silence, and it starts assessing the incoming message for
 * whether anyone remarked on that silence.
 *
 * So the previous *session* and the last *contribution* are different questions,
 * and only one of them was being asked. This block answers the second, reaching
 * past the message window on purpose: an agent that has been quiet is exactly
 * the case where its last contribution is no longer in view.
 *
 * The body is written without a voice — plain third-person fact — because a
 * block body cannot be swapped by the reading step the way its heading can, and
 * this one is read by `reflect`, which judges the agent's work as a third
 * party's.
 */
export const lastContribution: ContextBlock = {
  name: "last_contribution",
  heading: {
    agent: "The last thing you actually said here",
    observer: "The agent's own last contribution to this channel",
  },
  resolve: ({ lastContribution: last }) => {
    if (!last) return "The agent has not said anything in this channel.";

    // **Absent, not silent, when the previous session already carries it.** When
    // the agent answered last turn the previous session's artifacts hold that
    // answer, and repeating it here measurably hurt: restating the agent's own
    // reply immediately before asking "did it land?" primes `satisfied`.
    // `new-subject` and `prior-reflection-carried` both dropped to 2/3.
    //
    // Returning nothing at all now, rather than a sentence saying so. Under the
    // appendix mechanism absence costs no heading and no budget, which is
    // strictly better than the note this used to emit.
    if (last.messagesSince <= 1) return undefined;

    return (
      `The agent did not speak in the exchange just before this one. The last time it did, ` +
      `${last.messagesSince} messages ago, it wrote:\n\n"${last.text.trim()}"\n\n` +
      `Everything since has been other people talking.`
    );
  },
};
