import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Prompts ship with the repo. They are never written at runtime. */
export const DEFAULT_PROMPTS_DIR = path.join(REPO_ROOT, "prompts");

/**
 * Situation fragments, selected deterministically by conversational position —
 * distinct from the `name_1.md` / `name_2.md` mechanism, which is uniform
 * random A/B. The two compose: a fragment may itself have variants, and both
 * the fragment id and its variant are recorded separately in the trace.
 */
export const SITUATIONS_DIR = path.join(DEFAULT_PROMPTS_DIR, "situations");

export interface LoadedPrompt {
  /**
   * The variant actually chosen, e.g. `react_2`. Recorded in the session output
   * — without it the variant mechanism cannot be evaluated and is therefore
   * pointless.
   */
  variantId: string;
  text: string;
  path: string;
}

export interface LoadPromptOptions {
  dir?: string | undefined;
  /** Injectable for tests; defaults to `Math.random`. */
  rng?: (() => number) | undefined;
  /**
   * Pin a specific variant by id (`react_2`). Random selection is right in
   * production and useless in an eval, where mixing two prompts across runs
   * makes the comparison meaningless.
   */
  variant?: string | undefined;
}

/**
 * Loads the prompt for a step, picking uniformly at random among its variants.
 *
 * `name.md` is a single-variant prompt. `name_1.md`, `name_2.md`, … are
 * variants of the same step and are selected between per call.
 */
export async function loadPrompt(
  name: string,
  opts: LoadPromptOptions = {},
): Promise<LoadedPrompt> {
  const dir = opts.dir ?? DEFAULT_PROMPTS_DIR;
  const rng = opts.rng ?? Math.random;

  const variants = await listVariants(dir, name);
  if (variants.length === 0) {
    throw new Error(
      `No prompt file for step "${name}" in ${dir}. Expected ${name}.md or ${name}_1.md.`,
    );
  }

  let chosen: string;
  if (opts.variant) {
    const wanted = `${opts.variant}.md`;
    if (!variants.includes(wanted)) {
      throw new Error(
        `Prompt variant "${opts.variant}" not found in ${dir}. Available: ${variants.join(", ")}.`,
      );
    }
    chosen = wanted;
  } else {
    chosen = variants[Math.floor(rng() * variants.length)] as string;
  }

  const file = path.join(dir, chosen);

  return {
    variantId: chosen.replace(/\.md$/, ""),
    text: await readFile(file, "utf8"),
    path: file,
  };
}

/** Variant filenames for a step, sorted, so selection is reproducible under a fixed rng. */
export async function listVariants(dir: string, name: string): Promise<string[]> {
  const pattern = new RegExp(`^${escapeRegExp(name)}(?:_\\d+)?\\.md$`);
  const entries = await readdir(dir);
  return entries.filter((entry) => pattern.test(entry)).sort();
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
