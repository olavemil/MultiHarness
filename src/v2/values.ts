/**
 * Bounded values, written so they read as bounded.
 *
 * The argument is readability rather than safety: `"reasoning"` in a step
 * definition is quoted, and quotes say *free text*. `ModelRole.reasoning` is
 * dotted, and dots say *one of a known set*. You can tell which is which
 * without reading the contents, which is the property a Kotlin or Dart enum
 * gives you and a bare string union does not.
 *
 * A TypeScript `enum` cannot be used here at all — `tsconfig` sets
 * `erasableSyntaxOnly` because the daemon runs under Node's type stripping, and
 * both `enum` and `const enum` are rejected with TS1294. This is the standard
 * replacement and is better on every axis that matters here: it is iterable, it
 * is structurally typed so config strings validate against it directly with no
 * conversion layer, and a typo fails to compile in both the dotted and the bare
 * form.
 *
 * Declaring the value and the type under one name is deliberate. TypeScript
 * keeps separate value and type namespaces, so `ModelRole` resolves correctly
 * in both positions and callers need one import rather than two.
 */

export const ModelRole = {
  fast: "fast",
  reasoning: "reasoning",
  digest: "digest",
  embed: "embed",
} as const;
export type ModelRole = (typeof ModelRole)[keyof typeof ModelRole];

/**
 * Whether a step's own output is produced with tools in hand.
 *
 * Note what is *not* here: v1's `voice`. See `steps/types.ts` for why it was
 * removed rather than carried over.
 */
export const StepKind = {
  /** One constrained call. Output validated against the step's schema. */
  direct: "direct",
  /** A tool loop first, then one constrained call over what it found. */
  gathering: "gathering",
  /** No model call at all. */
  computed: "computed",
} as const;
export type StepKind = (typeof StepKind)[keyof typeof StepKind];

export const ALL_ROLES: readonly ModelRole[] = Object.values(ModelRole);
