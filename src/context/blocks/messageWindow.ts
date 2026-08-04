import { renderWindow, windowEntries } from "../../core/window.ts";
import type { ContextBlock } from "./types.ts";

/** Messages the window can carry. Kept small so ids stay cheap and legible. */
export const WINDOW_LIMIT = 12;

/**
 * Channel history rendered with local ids, times, and senders — the form a step
 * needs when its answer is *which* message something refers to.
 *
 * Separate from `recent_messages` on purpose: the plain form stays clean for
 * steps like `respond`, which would only be distracted by identifiers.
 */
export const messageWindow: ContextBlock = {
  name: "message_window",
  keep: "tail",
  resolve: ({ history }) => renderWindow(windowEntries(history, WINDOW_LIMIT)),
};
