import type { ChannelMessage } from "./types.ts";
import { detectMention, type AgentNames } from "./mentions.ts";

/** How far back the agent's own last message sits, if it is in the window at all. */
export type AgentDistance = "immediate" | "recent" | "absent";

export interface Situation {
  /** Another participant this message appears to address, if any. */
  mentionsOther: string | undefined;
  distance: AgentDistance;
  /**
   * Whether the message continues a subject the agent has itself spoken on,
   * measured by `core/standing.ts`. Undefined when it was not measured.
   */
  ownSubject: boolean | undefined;
  /**
   * Fragment id, `<mention>_<distance>` — e.g. `other_immediate` — with `_own`
   * appended where the message is on the agent's own subject. Selects which
   * question the react prompt actually asks.
   */
  id: string;
}

const AT_MENTION = /@([\w-]+)/g;

/**
 * Classifies the conversational position of an incoming message.
 *
 * Everything here is computable, so none of it should be left to the model.
 * What remains for the prompt is one specific question per situation, rather
 * than the vague "is this for you?" that a small model answers badly.
 *
 * Only called when the agent was *not* named — being named settles the decision
 * before this runs.
 */
export function computeSituation(
  text: string,
  history: readonly ChannelMessage[],
  agent: AgentNames,
  recentWindow = 8,
  /**
   * What the reply-target step concluded, when it ran. Supersedes the positional
   * heuristic: "this replies to one of your messages" is the judgement the
   * distance between messages was only ever standing in for.
   */
  replyTarget?: "agent" | "other" | "nothing" | undefined,
  /**
   * Whether this message continues something the agent said, from
   * `core/standing.ts`. A third routing axis rather than another paragraph in an
   * existing fragment — measured three times, appending a second test after a
   * terminal gate weakens the gate, and `open-question-recent` paid for it each
   * time. One fragment asks one question; that is the whole point of routing.
   */
  ownSubject?: boolean | undefined,
): Situation {
  const mentionsOther = detectOtherMention(text, history, agent);
  const distance = replyTarget
    ? distanceFromReplyTarget(replyTarget, history, recentWindow)
    : agentDistance(history, recentWindow);

  // Only where the agent has spoken but is not the last speaker. `absent` means
  // it has said nothing here, so there is no subject of its own to continue;
  // `immediate` is already engaged and needs no help deciding that.
  const own = ownSubject === true && distance === "recent";

  return {
    mentionsOther,
    distance,
    ownSubject,
    id: `${mentionsOther ? "other" : "none"}_${distance}${own ? "_own" : ""}`,
  };
}

/**
 * Maps a reply target onto the existing distance vocabulary, so the six
 * situation fragments keep working while the signal underneath gets better.
 */
function distanceFromReplyTarget(
  replyTarget: "agent" | "other" | "nothing",
  history: readonly ChannelMessage[],
  recentWindow: number,
): AgentDistance {
  // Replying to the agent is the thing `immediate` was always trying to detect,
  // and it holds however many messages ago that was.
  if (replyTarget === "agent") return "immediate";

  // Otherwise the reply target says nothing about *presence*, which is what the
  // remaining two values mean: `absent` claims the agent has not spoken here,
  // and asserting that of a conversation it took part in makes the fragment
  // factually wrong. Presence stays a question about history.
  return agentDistance(history, recentWindow);
}

/**
 * Candidate names come from who has actually spoken here, plus any `@handle`
 * in the text — so an unknown handle still reads as "addressed to someone else"
 * rather than being invisible.
 */
function detectOtherMention(
  text: string,
  history: readonly ChannelMessage[],
  agent: AgentNames,
): string | undefined {
  const agentTerms = new Set(
    [agent.name, ...agent.aliases].map((t) => t.trim().replace(/^@+/, "").toLowerCase()),
  );

  const candidates = new Set<string>();
  for (const message of history) {
    if (!message.fromAgent) candidates.add(message.author);
    // Handles named earlier count too. Someone can be a participant in the
    // conversation long before they say anything in it — once `@dana` has been
    // addressed, a later bare `dana` refers to a person, not a word.
    for (const [, handle] of message.text.matchAll(AT_MENTION)) {
      if (handle) candidates.add(handle);
    }
  }
  for (const [, handle] of text.matchAll(AT_MENTION)) {
    if (handle) candidates.add(handle);
  }

  for (const candidate of candidates) {
    if (agentTerms.has(candidate.trim().replace(/^@+/, "").toLowerCase())) continue;
    if (detectMention(text, { name: candidate, aliases: [] })) return candidate;
  }
  return undefined;
}

function agentDistance(history: readonly ChannelMessage[], recentWindow: number): AgentDistance {
  const window = history.slice(-recentWindow);
  const lastAgent = window.findLastIndex((message) => message.fromAgent);

  if (lastAgent === -1) return "absent";
  return lastAgent === window.length - 1 ? "immediate" : "recent";
}
