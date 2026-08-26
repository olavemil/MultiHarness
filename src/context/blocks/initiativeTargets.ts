import type { ContextBlock } from "./types.ts";

const ago = (ms: number): string => {
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

/**
 * Who the agent could write to unprompted, channels and people together.
 *
 * Only targets that passed the countable gates in `core/initiative.ts` are ever
 * in here, so a step reading it is choosing among places it is already allowed
 * to speak — it is never asked to respect a rule it could reason around.
 *
 * A person carries what is known about them, because that is most of what
 * decides whether writing to them is welcome. A channel carries how quiet it has
 * gone and how long since the agent last spoke there.
 */
export const initiativeTargets: ContextBlock = {
  name: "initiative_targets",
  heading: {
    agent: "Who you could write to",
    observer: "Who the agent could write to",
  },
  resolve: ({ initiativeTargets: targets }) => {
    if (!targets || targets.length === 0) return undefined;

    const channels = targets.filter((t) => t.kind === "channel");
    const people = targets.filter((t) => t.kind === "dm");
    const parts: string[] = [];

    if (channels.length > 0) {
      parts.push(
        "**Conversations**",
        "",
        ...channels.map((c) => {
          const since = c.agentHasSpoken
            ? `${c.messagesSinceAgentSpoke} message${c.messagesSinceAgentSpoke === 1 ? "" : "s"} since you last spoke`
            : "you have never spoken there";
          return `- \`${c.ref}\` **${c.name}** — quiet for ${ago(c.silentMs)}, ${since}`;
        }),
      );
    }

    if (people.length > 0) {
      if (parts.length > 0) parts.push("");
      parts.push(
        "**People you could message directly**",
        "",
        ...people.map((p) => {
          const seen = `last heard from ${ago(p.silentMs)} ago`;
          const known = p.summary ? `\n  ${p.summary}` : "";
          return `- \`${p.ref}\` **${p.name}** — ${seen}${known}`;
        }),
      );
    }

    return parts.join("\n");
  },
};
