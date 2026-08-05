import { z } from "zod";
import type { ModelStep } from "./types.ts";

export interface Response {
  message: string;
}

const schema = z.object({ message: z.string().min(1) }) as z.ZodType<Response>;

export const respond: ModelStep<Response> = {
  kind: "model",
  name: "respond",
  defaultRole: "reasoning",
  // Both the message and the restatement, deliberately: the reply has to answer
  // the actual message in its own terms, and `unresolved` is what it asks about
  // when the conversation did not settle the request.
  contextBlocks: [
    "user_summary",
    "recent_messages",
    "incoming_message",
    "request",
    "prior_step_output",
  ],
  outputFile: "response.md",
  buildSchema: () => schema,

  /**
   * The only fallback a person actually sees. Says the true thing briefly
   * rather than inventing an answer or going quiet.
   */
  fallback: () => ({
    message: "Sorry — something went wrong composing a reply. Could you ask me again?",
  }),

  render: (response) => response.message,
};
