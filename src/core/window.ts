import type { ChannelMessage } from "./types.ts";

/**
 * A window of recent messages, each given a short local id.
 *
 * Ids are window-local (`m1`, `m2`, …) rather than the real message ids, which
 * are UUIDs. Two reasons: a small model copying a UUID accurately is a
 * self-inflicted failure mode, and at roughly 20 tokens each a UUID per message
 * would consume most of the block's budget on identifiers. The model never sees
 * a UUID; `resolveLocalId` maps back.
 */

export interface WindowEntry {
  /** `m1`, `m2`, … oldest first. */
  localId: string;
  message: ChannelMessage;
}

export function windowEntries(
  history: readonly ChannelMessage[],
  limit: number,
): WindowEntry[] {
  return history
    .slice(-limit)
    .map((message, index) => ({ localId: `m${index + 1}`, message }));
}

/**
 * `[m3] 09:14 olav: morning` — id, time, sender, content.
 *
 * **Every turn is labelled with its author's name, the agent's included.** This
 * used to render the agent's own messages as `you`, which forced the only step
 * that reads this window to open by disclaiming its own input: *"its messages
 * are marked `you`. Ignore that label — you are not that participant."* A prompt
 * apologising for the harness's rendering is the harness's bug, not the
 * prompt's.
 *
 * It also made the transcript non-neutral. `reply_target` and its successor
 * `read` are objective steps whose entire job is deciding which participant a
 * message is aimed at, and a transcript that has already picked one out as
 * "you" has answered part of that question before the model reads it. With two
 * instances in a channel it was worse still: one agent's turns read `you` and
 * its sibling's read `nephele`, so the same conversation rendered differently
 * depending on who was looking.
 *
 * `fromAgent` still carries the fact for code that needs it.
 */
export function renderWindow(entries: readonly WindowEntry[]): string {
  if (entries.length === 0) return "";

  return entries
    .map(
      ({ localId, message }) =>
        `[${localId}] ${clockTime(message.at)} ${message.author}: ${message.text}`,
    )
    .join("\n");
}

export function resolveLocalId(
  entries: readonly WindowEntry[],
  localId: string,
): ChannelMessage | undefined {
  return entries.find((entry) => entry.localId === localId)?.message;
}

/** The ids a model may legally reference, for compiling into a schema. */
export const windowIds = (entries: readonly WindowEntry[]): string[] =>
  entries.map((entry) => entry.localId);

function clockTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "??:??"
    : `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
