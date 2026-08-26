/**
 * Tidying an emoji name the agent chose, without judging whether it was a good
 * choice.
 *
 * **The vocabulary is a suggestion, not a constraint.** It used to be compiled
 * into `stance`'s schema, so the agent could only ever pick from a list
 * somebody wrote for it — which is safe, and which is also why it never felt
 * like a person reacting. A person picks the emoji they mean, sometimes picks
 * one that does not exist, and occasionally picks one they regret. Two of those
 * three are the point.
 *
 * So the only check here is *shape*: that the name could be an emoji name at
 * all. Whether it **is** one is Slack's answer to give, and it gives it as
 * `invalid_name` — caught and logged by the adapter, so a bad guess costs a
 * missing reaction and a line in the log rather than a failed session.
 */

/** Slack emoji names: lowercase alphanumerics, underscores, `+`, `-`. */
const SHAPE = /^[a-z0-9_+-]{1,64}$/;

/**
 * Returns the normalised name, or `undefined` when it could not be one.
 *
 * Models write `:eyes:` about as often as `eyes`, and `Eyes` sometimes; none of
 * those is worth failing over, so they are all the same reaction. Anything left
 * that does not match `SHAPE` — a sentence, an actual emoji character, an empty
 * string — is refused rather than sent, because the adapter would turn it into
 * an API call that could only fail.
 */
export function normaliseEmoji(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim().replace(/^:+|:+$/g, "").toLowerCase();
  return SHAPE.test(name) ? name : undefined;
}
