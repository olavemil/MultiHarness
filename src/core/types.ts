/** Domain types shared across the harness. No behaviour lives here. */

/** A distinct communication partner. May be human or machine; the agent does not need to know. */
export interface Identity {
  id: string;
  displayName: string;
  /** Including @mention forms, so a message can be matched back to an identity. */
  aliases: string[];
  /** Running summary, synthesised from accumulated impressions. */
  summary: string;
  /**
   * How many impressions existed when `summary` was last written.
   *
   * Counting *new* impressions is what lets synthesis move off the reply path:
   * the previous scheme fired on `total % threshold === 0`, which only works if
   * the check runs exactly once per appended impression. An idle trigger fires
   * on its own schedule and needs a marker it can compare against.
   */
  synthesisedAt?: number;
}

/** A message as it arrives from an adapter. */
export interface InboundMessage {
  id: string;
  channelId: string;
  identityId: string;
  /** Display name as the adapter knows it. */
  authorName: string;
  text: string;
  receivedAt: string;
}

/**
 * Somebody reacted to a message the agent wrote.
 *
 * Deliberately *not* an `InboundMessage`. A reaction is a signal about how an
 * answer landed, not a request — running a whole session for a 👍 would cost a
 * pipeline to conclude that nothing was asked. It is recorded and read by
 * `reflect`, which is the step whose entire job is judging how the last answer
 * landed, and which until now had to infer that from prose.
 */
export interface InboundReaction {
  channelId: string;
  /** The agent message reacted to, as the adapter identifies it. */
  messageId: string;
  /** Emoji name without colons, e.g. `thumbsup`. */
  emoji: string;
  identityId: string;
  authorName: string;
  at: string;
  /** True when the reaction was taken away again. */
  removed: boolean;
}

/** A message as stored in a channel's history. */
export interface ChannelMessage {
  id: string;
  identityId: string;
  /** Display name at the time of writing, so history stays readable after renames. */
  author: string;
  text: string;
  at: string;
  /** True when this agent wrote it. */
  fromAgent: boolean;
}

/** A step that has finished and been sealed, within the current session. */
export interface CompletedStep {
  name: string;
  /** The one-line purpose assigned by `react`. Empty for the entry step itself. */
  topic: string;
  outputFile: string;
  /** The markdown that was sealed to `outputFile`. */
  content: string;
  durationMs: number;
  variantId?: string;
  fellBack?: boolean;
}
