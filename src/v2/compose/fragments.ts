/**
 * Composable prose fragments — the replacement for v1's `voice`.
 *
 * **v1 derived text from a declared property.** A step set `voice: "observer"`
 * and the builder silently picked a different heading for every block it
 * assembled. That is action at a distance: the step said one word and the
 * prompt changed in a dozen places you could not see from the step, and the
 * headings themselves lived in the block files rather than anywhere near the
 * prompt they landed in.
 *
 * **Here you pick the fragment.** `presentAgentAndChannel.agent` and
 * `.onlooker` are two functions returning two pieces of prose. Changing how a
 * step addresses the model means naming the other one, in the step, where you
 * can see it next to everything else the prompt contains. Nothing is derived.
 *
 * The cost is that the two variants can drift apart, since nothing forces them
 * to stay parallel. That is the intended trade: drift you can see in one file
 * beats consistency enforced by a mechanism you cannot.
 */

import type { Section } from "./section.ts";

export interface Principal {
  agentName: string;
  /** A phrase, not a paragraph — it sits inside a sentence. */
  persona: string;
  channelName: string;
}

/**
 * Who is being addressed and where they are.
 *
 * `agent` addresses the model as the participant. `onlooker` describes the
 * agent in the third person, for a step judging work rather than doing it.
 * The distinction matters because these models read "you" as
 * themselves-being-asked, so an analyst prompt written in second person
 * conflates "is this aimed at you" with "are you being asked this".
 */
export const presentAgentAndChannel = {
  agent: ({ agentName, persona, channelName }: Principal): Section =>
    `You are ${agentName}, ${persona}. You are taking part in ${channelName}.`,

  onlooker: ({ agentName, persona, channelName }: Principal): Section =>
    `${agentName} is ${persona}, a participant in ${channelName}. ` +
    `You are reading this conversation from outside it.`,
} as const;

/**
 * States that everything after the transcript is the agent's own working
 * material.
 *
 * Only meaningful in the `agent` variant — an onlooker is not the author of
 * anything in the prompt, so there is nothing to disclaim, and the fragment is
 * simply absent rather than reworded into something vacuous.
 */
export const materialIsYourOwn = {
  agent: (sender: string): Section =>
    `Everything below except the conversation itself is your own — your notes and what you ` +
    `know. ${sender} has not seen any of it and did not ask about it: do not answer it, quote ` +
    `it, or mention that it exists.`,

  onlooker: (): Section => undefined,
} as const;

/**
 * How work under judgement is framed.
 *
 * "Have you made progress?" is defensive and answers yes. "Has progress been
 * made here?" is the only reading that is any use, so a judging step presents
 * the session's output as a third party's.
 */
export const workUnderReview = {
  onlooker: (): Section =>
    "The work below was produced by somebody else. Read it as material to examine.",
} as const;
