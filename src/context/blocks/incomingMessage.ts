import type { ContextBlock } from "./types.ts";

/**
 * The triggering message, as text and nothing else.
 *
 * The author used to be prefixed here. It is not any more: every frame that
 * uses this block already names `${sender}`, and a second copy inside the block
 * made the message look like a transcript line rather than the thing being
 * answered.
 *
 * Absent on a session no message triggered. That used to render as "(nothing was
 * said)", which reads as a message that said nothing — a maintenance or
 * continuation session simply does not declare this block.
 */
export const incomingMessage: ContextBlock = {
  name: "incoming_message",
  keep: "tail",
  heading: {
    agent: "The message you are answering",
    observer: "The message from ${sender} that triggered the session",
  },
  resolve: ({ message }) => message?.text,
};
