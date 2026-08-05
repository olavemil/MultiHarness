import type { ContextBlock } from "./types.ts";

/**
 * Messages that arrived while the session was already working, each with the
 * verdict the supervisor reached about it.
 *
 * Both halves matter and neither is available anywhere else. The messages are
 * not in `recent_messages` — history was read before the session began — and the
 * verdicts exist only in the trace. A step asked whether an interruption was
 * handled well needs to see what was said *and* what was decided about it.
 */
export const midSessionMessages: ContextBlock = {
  name: "mid_session_messages",
  keep: "tail",
  resolve: ({ arrivals }) => {
    if (!arrivals || arrivals.length === 0) {
      return "(nothing arrived while this session was running)";
    }
    return arrivals
      .map((a) => `${a.author}: ${a.text}\n  → the session decided: ${a.verdict}`)
      .join("\n\n");
  },
};
