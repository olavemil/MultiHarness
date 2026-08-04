const PLACEHOLDER = /\$\{(\w+)\}/g;

/** Every `${name}` referenced by a template, deduplicated. */
export function templateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))];
}

/**
 * Substitutes `${name}` placeholders.
 *
 * Throws on an unsupplied variable rather than leaving a literal `${name}` in
 * the prompt. A step whose declared context blocks have drifted from its
 * template should fail at render time, not silently ship a broken prompt to
 * the model.
 */
export function render(template: string, vars: Readonly<Record<string, string>>): string {
  const missing = new Set<string>();

  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      missing.add(name);
      return "";
    }
    return value;
  });

  if (missing.size > 0) {
    throw new Error(
      `Prompt template referenced undefined variable(s): ${[...missing].join(", ")}. ` +
        `Supplied: ${Object.keys(vars).join(", ") || "(none)"}.`,
    );
  }

  return rendered;
}
