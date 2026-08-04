import { z } from "zod";
import type { ToolDefinition } from "../types.ts";
import { capText, wrapUntrusted } from "./untrusted.ts";

const API = "https://en.wikipedia.org/w/api.php";
const MAX_CHARS = 5_000;
const TIMEOUT_MS = 15_000;

interface SearchResponse {
  query?: { search?: { title: string }[] };
}
interface ExtractResponse {
  query?: { pages?: Record<string, { title?: string; extract?: string }> };
}

/**
 * Searches Wikipedia and returns plain-text extracts.
 *
 * A special-cased site rather than a general search engine: one known API, no
 * key, and a predictable shape. Its output is still untrusted — an article is
 * editable by anyone — so it is fenced like any other retrieved text.
 */
export const wikipediaSearch: ToolDefinition<{ query: string }> = {
  name: "wikipedia_search",
  description:
    "Search Wikipedia and return the opening text of the best-matching articles. " +
    "Good for background on a named subject; not for anything recent or contested.",
  parameters: z.object({ query: z.string() }),
  readOnly: true,

  run: async ({ query }, ctx) => {
    const agent = { "user-agent": ctx.config.web.user_agent };
    const get = async <T>(params: Record<string, string>): Promise<T> => {
      const url = new URL(API);
      for (const [k, v] of Object.entries({ format: "json", origin: "*", ...params })) {
        url.searchParams.set(k, v);
      }
      const response = await fetch(url, { headers: agent, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
      return (await response.json()) as T;
    };

    try {
      const found = await get<SearchResponse>({
        action: "query",
        list: "search",
        srsearch: query,
        srlimit: "3",
      });
      const titles = (found.query?.search ?? []).map((s) => s.title);
      if (titles.length === 0) return `No Wikipedia article matches "${query}".`;

      const extracts = await get<ExtractResponse>({
        action: "query",
        prop: "extracts",
        exintro: "1",
        explaintext: "1",
        titles: titles.join("|"),
      });

      const body = Object.values(extracts.query?.pages ?? {})
        .filter((page) => page.extract)
        .map((page) => `## ${page.title}\n${page.extract}`)
        .join("\n\n");

      return body === ""
        ? `Found ${titles.join(", ")} but no readable extract.`
        : wrapUntrusted(`Wikipedia (${titles.join(", ")})`, capText(body, MAX_CHARS));
    } catch (cause) {
      return `Wikipedia search failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  },
};
