/**
 * A prompt is an array of sections. Nothing else.
 *
 * Three properties this buys, and each was a specific v1 complaint:
 *
 * - **Order is explicit.** An array, not a named dictionary. Position is the
 *   priority the model reads it at, and it is also what makes a forward or
 *   backward reference in prose ("the draft above") true or false. A dictionary
 *   cannot express either, so v1 kept the order in a separate `appendix` list
 *   and hoped the two agreed.
 * - **No hidden nesting.** v1 had one `${context}` hole whose contents were
 *   decided elsewhere, so you could not tell what a prompt read like by reading
 *   it. Here the array *is* the prompt.
 * - **Absence is structural.** A section that resolves to nothing contributes
 *   no heading, no placeholder and no blank line, because `false` and
 *   `undefined` are members of the type rather than something a resolver has to
 *   remember to special-case.
 */

/**
 * A piece of a prompt.
 *
 * `false | undefined | null` are admitted so `cond && [...]` is the way to make
 * a section conditional — an `if` statement cannot appear inside an array
 * literal, and this reads the same.
 */
export type Section = string | false | undefined | null | readonly Section[];

/**
 * Joins sections into prompt text.
 *
 * **A nested array joins tightly, the top level joins with a blank line.** That
 * single rule is what makes a heading stick to its body and a fenced block stay
 * intact, without anyone writing `\n` by hand.
 *
 *     compose([
 *       "# Research",
 *       ["## Message", "```", text, "```"],
 *       reflection && ["## Reflection", reflection],
 *     ])
 *
 * With `reflection` absent that renders no Reflection heading at all.
 */
export function compose(sections: readonly Section[]): string {
  return sections
    .map(tight)
    .filter((s): s is string => s !== undefined)
    .join("\n\n");
}

function tight(section: Section): string | undefined {
  if (section === false || section === undefined || section === null) return undefined;

  if (Array.isArray(section)) {
    const parts = section.map(tight).filter((s): s is string => s !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  const text = section as string;
  return text.trim() === "" ? undefined : text;
}

/**
 * Indents any markdown heading in `body` to sit below `level`.
 *
 * The v1 bug this exists for: `reflect` seals a document that opens with an
 * `# Reflection` H1, and the `reflection` context block injected it wholesale
 * into another prompt. An H1 arriving inside another document's body is not
 * valid structure, and v1 worked around it by fencing appendices in `----------`
 * rules rather than headings — which is a symptom being managed, not fixed.
 *
 * Demoting instead keeps one coherent document. Fenced code is skipped, so a
 * `# comment` inside a snippet is left alone.
 */
export function demote(body: string, level: number): string {
  const lines = body.split("\n");
  let fenced = false;

  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;

      const heading = /^(#{1,6})(\s+.*)$/.exec(line);
      if (!heading) return line;

      const depth = Math.min(heading[1]!.length + level, 6);
      return "#".repeat(depth) + heading[2]!;
    })
    .join("\n");
}

/**
 * A section whose body is a document produced by another step.
 *
 * Always use this rather than interpolating sealed output directly: it demotes
 * the body's headings under `heading`, and it disappears entirely when the body
 * is empty, which is the two rules that were violated together in v1.
 */
export function document(heading: string, body: string | undefined): Section {
  const text = body?.trim();
  if (!text) return undefined;

  const level = /^(#{1,6})\s/.exec(heading)?.[1]?.length ?? 2;

  // Joined here rather than returned as `[heading, body]`, because a nested
  // array joins tightly and a heading wants a blank line under it when its body
  // is a whole document. An empty string cannot separate them: a blank section
  // is dropped, which is the rule that makes absence free everywhere else.
  return `${heading}\n\n${demote(text, level)}`;
}
