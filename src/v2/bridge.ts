import type { Config } from "../config/schema.ts";
import type { ChannelMessage, Identity, InboundMessage } from "../core/types.ts";
import type { PriorSession } from "../store/priorSession.ts";
import type { StepInput } from "./steps/input.ts";

/**
 * Adapts the values the instance runner already holds into v2's `StepInput`.
 *
 * Kept in one small function on purpose. The whole v2/v1 seam is this file plus
 * one `if` at each call site, so turning the experiment off is deleting a
 * folder rather than unpicking a change threaded through the runner.
 *
 * Note what the conversion *drops*: v1's `BlockInput` carries fifteen-odd
 * optional fields, several of which exist to feed blocks that render
 * placeholder prose when empty. v2 takes only what its two steps actually read,
 * and adding a field is a change to `StepInput` where the type will point at
 * every step that must now decide what to do about it.
 */
export function toStepInput(args: {
  config: Config;
  channelName: string;
  identity: Identity;
  message?: InboundMessage | undefined;
  history: readonly ChannelMessage[];
  prior?: PriorSession | undefined;
  impressions?: readonly { text: string }[] | undefined;
  lastContribution?: { text: string; messagesSince: number } | undefined;
}): StepInput {
  const { config, message, prior } = args;

  return {
    principal: {
      agentName: config.agent.name,
      persona: config.agent.personality,
      channelName: args.channelName,
    },
    sender: args.identity.displayName,
    ...(message ? { message: message.text } : {}),
    history: args.history.map((m) => ({ author: m.author, text: m.text })),
    completed: [],
    ...(prior
      ? {
          prior: {
            ...(prior.request ? { request: prior.request } : {}),
            ...(prior.reflection ? { reflection: prior.reflection } : {}),
            ...(prior.review ? { review: prior.review } : {}),
          },
        }
      : {}),
    ...(args.lastContribution ? { lastContribution: args.lastContribution } : {}),
    impressions: (args.impressions ?? []).map((i) => i.text),
  };
}
