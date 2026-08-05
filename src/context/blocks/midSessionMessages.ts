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
/**
 * Spelled out rather than passed through as a bare verdict name, because the
 * names do not say what a reader needs to know: whether *this* session took the
 * message on.
 *
 * `adjust` and `respond_now` change what the session does, so it owns the
 * arrival and owes it an answer. `continue` and `abort` leave it queued for a
 * session of its own. Seen live: an arrival the session carried past was
 * reported unanswered and carried forward, while the very next session was
 * already answering it.
 */
const describe = (verdict: string): string => {
  switch (verdict) {
    case "abort":
      return "stop this session's work — the message stays queued for its own session";
    case "respond_now":
      return "cut the remaining work and reply to it here";
    case "adjust":
      return "re-schedule the rest of this session around it, and answer it here";
    default:
      return "carry on — the message stays queued and gets a session of its own";
  }
};

export const midSessionMessages: ContextBlock = {
  name: "mid_session_messages",
  keep: "tail",
  resolve: ({ arrivals }) => {
    if (!arrivals || arrivals.length === 0) {
      return "(nothing arrived while this session was running)";
    }
    return arrivals
      .map((a) => `${a.author}: ${a.text}\n  → the session decided: ${describe(a.verdict)}`)
      .join("\n\n");
  },
};
