import type { ContextBlock } from "./types.ts";

/**
 * What the agent worked out in its own time, between conversations.
 *
 * Cross-channel, and the latest revision only — the history is on disk but a
 * step reading this wants the agent's current view, not the accretion.
 *
 * **Deliberately not given to `reflect`.** That step judges how one exchange
 * landed, and its own documented failure mode is finding significance that is
 * not there; handing it the agent's unrelated preoccupations invites exactly
 * that, and background musing is not evidence about whether an answer worked.
 * The readers are the steps that *act* — `plan`, `research`, `initiate` — where
 * continuity of thought is the whole point.
 */
export const backgroundThinking: ContextBlock = {
  name: "background_thinking",
  heading: {
    agent: "What you have been thinking about between conversations",
    observer: "What the agent has been thinking about between conversations",
  },
  resolve: ({ thinking }) => thinking?.trim() || undefined,
};
