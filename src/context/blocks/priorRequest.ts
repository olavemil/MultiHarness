import type { ContextBlock } from "./types.ts";

/**
 * How the previous session in this channel understood what was being asked.
 *
 * The block `last_session_summary` looks like it should carry this and does not:
 * `summarize` is a computed step emitting a table of steps and durations, so it
 * records what ran, never what it was taken to mean.
 *
 * Absent when the previous session declined to reply — `restate` runs only on
 * the answering path — and on any session predating the step.
 */
export const priorRequest: ContextBlock = {
  name: "prior_request",
  resolve: ({ prior }) =>
    prior?.request.trim() || "(the previous session recorded no reading of what was asked)",
};
