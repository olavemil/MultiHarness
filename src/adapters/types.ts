import type { InboundMessage } from "../core/types.ts";

export type InboundHandler = (message: InboundMessage) => void;

/**
 * A transport binding. Adapters carry no pipeline logic — they turn a transport
 * into `InboundMessage`s and send text back.
 *
 * The local GUI is an adapter like any other: its history is channel history,
 * its input box is an inbound message, its status line is `status()`.
 */
export interface Adapter {
  id: string;
  start(onMessage: InboundHandler): Promise<void>;
  send(channelId: string, text: string): Promise<void>;
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
