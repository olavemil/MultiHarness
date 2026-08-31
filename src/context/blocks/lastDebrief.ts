import type { ContextBlock } from "./types.ts";

/**
 * The previous session's debrief, when that session was interrupted.
 *
 * Usually absent, because most sessions are never interrupted. When it is
 * present it is the only record that somebody asked something mid-session and
 * never got an answer — that question exists in no other artifact once the
 * session which absorbed it has ended.
 */
export const lastDebrief: ContextBlock = {
  name: "last_debrief",
  heading: {
    agent: "A question the last session was interrupted by and may still owe",
    observer: "What interrupted the previous session, and what it may still owe",
  },
  resolve: ({ prior }) => prior?.debrief.trim() || undefined,
};
