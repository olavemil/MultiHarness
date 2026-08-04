import { z } from "zod";
import { KNOWLEDGE } from "../knowledge/db.ts";
import { writeKnowledge } from "../knowledge/gatekeeper.ts";
import { findEntry, listEntries, readContents, search } from "../knowledge/store.ts";
import type { ToolDefinition } from "./types.ts";

/** Keeps a single tool result from swallowing the step's whole context budget. */
const CAP = 2_000;
const cap = (text: string): string =>
  text.length <= CAP ? text : `${text.slice(0, CAP)}\n[… truncated]`;

export const knowledgeSearch: ToolDefinition<{ query: string }> = {
  name: "knowledge_search",
  description:
    "Search stored knowledge by keyword. Returns matching topics with their summaries. " +
    "Use this before answering anything the agent may already know.",
  parameters: z.object({ query: z.string() }),
  readOnly: true,

  run: async ({ query }, ctx) => {
    const hits = search(ctx.knowledge(), KNOWLEDGE, query, 10);
    if (hits.length === 0) return `No stored knowledge matches "${query}".`;
    return cap(hits.map((e) => `- ${e.topic} — ${e.summary}`).join("\n"));
  },
};

export const knowledgeRead: ToolDefinition<{ topic: string }> = {
  name: "knowledge_read",
  description:
    "Read everything stored under one topic, exactly as it was written. " +
    "Use after knowledge_search has named a topic worth opening.",
  parameters: z.object({ topic: z.string() }),
  readOnly: true,

  run: async ({ topic }, ctx) => {
    const db = ctx.knowledge();
    const entry = findEntry(db, KNOWLEDGE, topic.trim().toLowerCase());
    if (!entry) {
      const known = listEntries(db, KNOWLEDGE)
        .slice(0, 20)
        .map((e) => e.topic)
        .join(", ");
      return `No topic "${topic}". Known topics: ${known || "(the store is empty)"}.`;
    }
    const blocks = readContents(db, entry.id).map((c) => `- ${c.text}`);
    return cap(`# ${entry.topic}\n${entry.summary}\n\n${blocks.join("\n")}`);
  },
};

/**
 * The only write path a step gets, and it is not a direct write: the candidate
 * goes to the gatekeeper, which decides whether it is stored at all. A step
 * cannot put anything into the store on its own authority.
 */
export const knowledgeWrite: ToolDefinition<{ text: string }> = {
  name: "knowledge_write",
  description:
    "Offer a durable fact for storage. It is reviewed before being kept, and may be " +
    "rejected as duplicated, too vague, or not a fact about a subject. One fact per call.",
  parameters: z.object({ text: z.string() }),
  readOnly: false,

  run: async ({ text }, ctx) => {
    const result = await writeKnowledge({
      db: ctx.knowledge(),
      config: ctx.config,
      namespace: KNOWLEDGE,
      candidate: text,
      provenance: { session: ctx.session, step: ctx.step },
    });

    // The verdict is reported back so the model learns what the store accepts
    // rather than repeating a rejected shape.
    switch (result.verdict) {
      case "append":
        return `Stored under existing topic "${result.entry?.topic}".`;
      case "new":
      case "collides":
        return `Stored as new topic "${result.entry?.topic}".`;
      default:
        return `Not stored: ${result.reason}`;
    }
  },
};
