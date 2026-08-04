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

/** `[m3] 09:14 olav: morning` — id, time, sender, content. */
export function renderWindow(entries: readonly WindowEntry[]): string {
  if (entries.length === 0) return "(no earlier messages in this channel)";

  return entries
    .map(({ localId, message }) => {
      const author = message.fromAgent ? "you" : message.author;
      return `[${localId}] ${clockTime(message.at)} ${author}: ${message.text}`;
    })
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
