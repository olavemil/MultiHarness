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
 * Empty is the common and correct case. A correction invented where none was
 * warranted would steer this session's restatement away from a reading that was
 * right — the same compounding failure `no_signal` exists to prevent.
 */
export const requestCorrection: ContextBlock = {
  name: "request_correction",
  resolve: ({ requestCorrection }) =>
    requestCorrection?.trim() || "(no correction — the previous reading was not challenged)",
};
