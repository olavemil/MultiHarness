import type { ContextBlock } from "./types.ts";

/**
 * This session's own `reflect` output — the course-correction written at the
 * start of this session, as distinct from `last_reflection`, which is the
 * previous session's.
 *
 * Absent when `reflect` did not run, which is every first session in a channel.
 */
export const reflection: ContextBlock = {
  name: "reflection",
  heading: {
    agent: "What you decided at the start of this session",
    observer: "Course-correction written at the start of this session",
  },
  resolve: ({ completed }) => completed.find((s) => s.name === "reflect")?.content.trim(),
};
