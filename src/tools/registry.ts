import { knowledgeRead, knowledgeSearch, knowledgeWrite } from "./knowledge.ts";
import { fetchUrl } from "./web/fetchUrl.ts";
import { wikipediaSearch } from "./web/wikipedia.ts";
import type { AnyTool } from "./types.ts";

/** Adding a tool: one definition above, one line here, one name in a step's allowlist. */
const ALL: readonly AnyTool[] = [
  knowledgeSearch,
  knowledgeRead,
  knowledgeWrite,
  fetchUrl,
  wikipediaSearch,
];

const REGISTRY = new Map(ALL.map((tool) => [tool.name, tool]));

export const KNOWN_TOOL_NAMES: readonly string[] = ALL.map((t) => t.name);

/**
 * Resolves a step's allowlist. An unknown name is a configuration error and
 * fails loudly — silently granting nothing would look like a model that simply
 * chose not to use its tools.
 */
export function resolveTools(names: readonly string[]): AnyTool[] {
  return names.map((name) => {
    const tool = REGISTRY.get(name);
    if (!tool) {
      throw new Error(`Unknown tool "${name}". Known tools: ${KNOWN_TOOL_NAMES.join(", ")}.`);
    }
    return tool;
  });
}
