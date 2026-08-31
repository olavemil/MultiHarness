import type { ContextBlock } from "./types.ts";

/**
 * `reflect`'s finding that the previous session answered the wrong reading of
 * what was asked.
 *
 * This is the recovery path for the one failure `restate` measurably has: given
 * two candidate referents it conjoins them and calls the request settled, and
 * neither a prompt rewrite nor a 3× larger model moved that. What does move it
 * is the next thing the person says. "No, I meant the other one" is a far
 * stronger signal than anything available in the transcript, and `reflect` is
 * the only step positioned to see it.
 *
 * Absent is the common and correct case — and now genuinely absent rather than a
 * sentence announcing that no correction was made, which was one more thing for
 * a small model to weigh.
 */
export const requestCorrection: ContextBlock = {
  name: "request_correction",
  heading: {
    agent: "A correction to that reading, recorded after seeing the reply land",
    observer: "A correction recorded against that reading",
  },
  resolve: ({ requestCorrection }) => requestCorrection?.trim() || undefined,
};
