import type { ContextBlock } from "./types.ts";

export const incomingMessage: ContextBlock = {
  name: "incoming_message",
  keep: "tail",
  resolve: ({ message, identity }) => `${identity.displayName}: ${message.text}`,
};
