import { z } from "zod";
import type { Config } from "../config/schema.ts";
import type { BlockInput } from "../context/blocks/index.ts";
import { WINDOW_LIMIT } from "../context/blocks/messageWindow.ts";
import { resolveLocalId, windowEntries, windowIds } from "../core/window.ts";
import type { ModelStep } from "./types.ts";

/**
 * Reading the room, from outside it. The first half of what `react` used to do,
 * with `reply_target` folded in.
 *
 * **Purely objective, and that is the point of the split.** `react` decoded a
 * classification (what does this message want, of whom) and a self-assessment
 * (has the agent got anything to add) in one constrained decode, in one voice.
 * The seam was visible in the prompt: widening the classification from a boolean
 * to four outcomes gave the model escape hatches from the situation fragment's
 * conclusion, and needed a patch sentence saying the fragment settles the reply
 * and the outcomes only spell out how silence is spelled. That sentence existed
 * because two questions shared one decode. They no longer do.
 *
 * **Absorbing `reply_target` keeps the call count where it was** — two `fast`
 * calls on the entry path before the split, two after — and both read the same
 * transcript either way. It also lets one prompt stop apologising for the other:
 * `reply_target` opened by disclaiming the `you` label the harness had put on
 * the agent's own turns, which `core/window.ts` no longer emits.
 *
 * Nothing here is decided by the model that the harness can decide itself.
 * Whether the agent was *named* is still settled by `core/mentions.ts` before
 * this runs, and a named message skips this step entirely.
 */

export const NOTHING = "nothing";

/** Who the final message is aimed at. */
export type Addressee = "agent" | "other" | "room";

/** What it wants back. */
export type Wants = "answer" | "acknowledgement" | "nothing";

export interface Reading {
  reason: string;
  /** Window-local id of the message being replied to, or `nothing`. */
  target: string;
  addressee: Addressee;
  wants: Wants;
}

/** Who the reply target turned out to be, once the local id is resolved. */
export type ReplyTargetKind = "agent" | "other" | "nothing";

/**
 * Resolves the decoded local id back to a participant, for `core/situation.ts`.
 * Window-local because a small model copying a UUID accurately is a
 * self-inflicted failure, and a UUID per message would eat the block's budget.
 */
export function replyTargetKind(
  reading: Reading,
  history: readonly { fromAgent: boolean }[],
): ReplyTargetKind {
  if (reading.target === NOTHING) return NOTHING;
  const entries = windowEntries(history as never, WINDOW_LIMIT);
  const message = resolveLocalId(entries, reading.target);
  if (!message) return NOTHING;
  return message.fromAgent ? "agent" : "other";
}

/**
 * Compiled from the ids actually in the window, so constrained decoding cannot
 * emit a reference to a message that is not there.
 */
function buildSchema(_config: Config, input: BlockInput): z.ZodType<Reading> {
  const ids = windowIds(windowEntries(input.history, WINDOW_LIMIT));
  // `nothing` leads, so the tuple is non-empty even for an empty window.
  const options: [string, ...string[]] = [NOTHING, ...ids];

  // Reason first, then the three facts it justifies — the field-order lever
  // that took `react` from 9/10 to 10/10 when three prompt rewrites could not.
  // `target` precedes `addressee` because what a message replies to is most of
  // what settles who it is aimed at.
  return z.object({
    reason: z.string(),
    target: z.enum(options),
    addressee: z.enum(["agent", "other", "room"]),
    wants: z.enum(["answer", "acknowledgement", "nothing"]),
  }) as z.ZodType<Reading>;
}

export const read: ModelStep<Reading> = {
  kind: "model",
  name: "read",
  defaultRole: "fast",
  voice: "observer",
  contextBlocks: ["incoming_message"],
  // The transcript is optional because a first message in a channel has none,
  // and the schema degrades to `nothing` on its own when the window is empty.
  appendix: ["message_window"],
  outputFile: "reading.md",
  buildSchema,

  /**
   * Claiming a reply target on a parse failure would invent a conversational
   * link that may not exist, so `nothing` asserts the least. `wants: answer`
   * with `addressee: room` is the opposite choice and equally deliberate: a
   * parse failure is a harness problem, and going silent over one looks exactly
   * like being ignored to the person waiting. The verdict it derives to is
   * `reply`, which still faces the participation draw.
   */
  fallback: () => ({
    reason: "The reading could not be parsed; assuming an answer is wanted and no reply target.",
    target: NOTHING,
    addressee: "room",
    wants: "answer",
  }),

  render: (reading) =>
    [
      "# Reading",
      "",
      `**Replying to:** ${reading.target}`,
      `**Aimed at:** ${reading.addressee}`,
      `**Wants:** ${reading.wants}`,
      "",
      `**Reason:** ${reading.reason}`,
    ].join("\n"),
};
