type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep-merges `override` onto `base`, returning a new object.
 *
 * Arrays replace wholesale rather than concatenating — a user who overrides
 * `closing_steps` means "these steps", not "these steps as well as the defaults".
 */
export function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlain(existing) && isPlain(value) ? deepMerge(existing, value) : value;
  }
  return out;
}
