import type { InboundMessage, InboundReaction } from "../core/types.ts";

export type InboundHandler = (message: InboundMessage) => void;
export type ReactionHandler = (reaction: InboundReaction) => void;

/**
 * What an adapter delivers. A record rather than a positional argument so a
 * transport that has no notion of reactions simply never calls that one, and
 * adding a third kind later does not change every implementation.
 */
export interface AdapterHandlers {
  onMessage: InboundHandler;
  /** Optional: only transports with reactions ever call it. */
  onReaction?: ReactionHandler | undefined;
}

/**
 * A transport binding. Adapters carry no pipeline logic — they turn a transport
 * into `InboundMessage`s and send text back.
 *
 * The local GUI is an adapter like any other: its history is channel history,
 * its input box is an inbound message, its status line is `status()`.
 */
export interface Adapter {
  id: string;
  start(handlers: AdapterHandlers): Promise<void>;
  send(channelId: string, text: string): Promise<void>;
  /**
   * Mark a message rather than replying to it. Optional: a transport without
   * reactions simply does not offer it, and the harness falls back to silence.
   */
  react?(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Optional progress line. Never load-bearing — adapters may ignore it. */
  status?(channelId: string, headline: string): void;
  /**
   * Resolves when the transport's input has ended.
   *
   * Adapters report this rather than terminating the process themselves: the
   * daemon owns its own lifetime and has in-flight sessions to finish first.
   */
  closed(): Promise<void>;
  stop(): Promise<void>;
}
