import type { ContextBlock } from "./types.ts";

export const incomingMessage: ContextBlock = {
  name: "incoming_message",
  keep: "tail",
  // A maintenance session has no triggering message. Saying so plainly beats an
  // empty block, which a model reads as a message that said nothing.
  resolve: ({ message, identity }) =>
    message
      ? `${identity.displayName}: ${message.text}`
      : "(nothing was said — this session was not triggered by a message)",
};
