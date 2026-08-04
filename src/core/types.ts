/** Domain types shared across the harness. No behaviour lives here. */

/** A distinct communication partner. May be human or machine; the agent does not need to know. */
export interface Identity {
  id: string;
  displayName: string;
  /** Including @mention forms, so a message can be matched back to an identity. */
  aliases: string[];
  /** Running summary, rewritten by `reflect` once that step lands. */
  summary: string;
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
