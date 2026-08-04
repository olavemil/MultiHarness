import type { ContextBlock } from "./types.ts";
import { incomingMessage } from "./incomingMessage.ts";
import { lastReflection } from "./lastReflection.ts";
import { lastReview } from "./lastReview.ts";
import { lastSessionSummary } from "./lastSessionSummary.ts";
import { reflection } from "./reflection.ts";
import { messageWindow } from "./messageWindow.ts";
import { priorStepOutput } from "./priorStepOutput.ts";
import { recentMessages } from "./recentMessages.ts";
import { sessionSummary } from "./sessionSummary.ts";
import { userSummary } from "./userSummary.ts";

/** Adding a context block: one file above, one line here. Nothing else changes. */
const ALL: readonly ContextBlock[] = [
  incomingMessage,
  recentMessages,
  messageWindow,
  userSummary,
  priorStepOutput,
  sessionSummary,
  lastReview,
  lastSessionSummary,
  lastReflection,
  reflection,
];

export const BLOCK_REGISTRY: ReadonlyMap<string, ContextBlock> = new Map(
  ALL.map((block) => [block.name, block]),
);

export const KNOWN_BLOCK_NAMES: readonly string[] = ALL.map((block) => block.name);

export type { BlockInput, ContextBlock } from "./types.ts";
