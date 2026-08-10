import type { Config } from "../config/schema.ts";
import type { ChannelMessage } from "./types.ts";
import { cosine } from "../knowledge/similarity.ts";
import { embed } from "../model/ollama.ts";
import { resolveRole } from "../model/roles.ts";

/**
 * Whether an arriving message continues something the agent itself has been
 * part of — its **standing** in the conversation, as distinct from having been
 * addressed.
 *
 * The failure this answers, seen live with two instances in one channel: the
 * agent that was not the previous speaker declines everything, because every
 * test it applies is a test of *invocation*. Someone carrying on a claim the
 * agent made two messages ago is not invoking it, and a conversation partner
 * would still have something to say.
 *
 * **Judged in code, because a model could not do it.** `react` was given an
 * `own_subject` boolean decoded before the verdict, so the question could not be
 * skipped; phi4 scored 0/3 on it and qwen3.6:27b scored 3/3. Putting a 27B on
 * the entry step of every message costs ~82s against ~2.7s, which is not a trade
 * worth making — and a cosine similarity against the agent's own recent turns is
 * a fact the harness can simply establish, the same treatment mention detection
 * gets. The prompt is then told the answer rather than asked the question.
 *
 * This is the first use of the `embed` role outside the knowledge gatekeeper,
 * which is where <1 GB of resident model has been sitting idle.
 */

export interface Standing {
  /** Highest cosine similarity between the message and any recent agent turn. */
  score: number;
  /** The agent's own turn that matched, for the prompt and the trace. */
  nearest: string;
  /** Whether `score` clears the configured threshold. */
  related: boolean;
}

/**
 * Undefined when there is nothing to compare: the agent has not spoken here, the
 * feature is off, or the embedding model could not be reached.
 *
 * **Absent is not "unrelated".** A failed embed call must leave the prompt
 * saying nothing about standing rather than asserting there is none, or an
 * unreachable model would silence the agent everywhere and look like a decision.
 */
export async function agentStanding(
  config: Config,
  history: readonly ChannelMessage[],
  text: string,
  signal?: AbortSignal,
): Promise<Standing | undefined> {
  const settings = config.session.standing;
  if (!settings.enabled) return undefined;

  // Most recent first: what the agent said five minutes ago bears on this more
  // than what it said an hour ago, and the cap keeps the call small.
  const turns = history
    .filter((message) => message.fromAgent && message.text.trim() !== "")
    .slice(-settings.turns)
    .reverse()
    .map((message) => message.text);

  if (turns.length === 0) return undefined;

  try {
    const [incoming, ...priors] = await embedAll(config, [text, ...turns], signal);
    if (!incoming) return undefined;

    let best = { score: -1, nearest: "" };
    for (const [index, vector] of priors.entries()) {
      const score = cosine(incoming, vector);
      if (score > best.score) best = { score, nearest: turns[index] as string };
    }

    return { ...best, related: best.score >= settings.threshold };
  } catch (cause) {
    // Soft failure by design — see above.
    console.warn(`[standing] could not measure standing: ${String(cause)}`);
    return undefined;
  }
}

/**
 * One request for the message and every turn compared against it.
 *
 * `/api/embed` takes a batch, so this is a single round trip on a sub-gigabyte
 * model rather than one per turn — which is what keeps it off the latency
 * budget that ruled out asking a 27B the same question.
 */
async function embedAll(
  config: Config,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  signal?.throwIfAborted();
  const role = resolveRole(config, "embed");
  const result = await embed(config.ollama.host, role.model, inputs, {
    timeoutMs: config.ollama.request_timeout_ms,
    ...(role.keepAlive !== undefined ? { keepAlive: role.keepAlive } : {}),
    options: role.options,
    ...(signal ? { signal } : {}),
  });
  return result.embeddings;
}

/**
 * How the fact is stated to the model. Analyst voice, like `agent_mentioned`,
 * because its only reader is a classification step on `fast`.
 */
export function describeStanding(standing: Standing | undefined): string {
  if (!standing) return "Not established for this message.";

  const quoted = standing.nearest.replace(/\s+/g, " ").slice(0, 200);
  return standing.related
    ? `Yes — this message is on a subject the agent itself has spoken on here. ` +
        `Its nearest own contribution was: "${quoted}"`
    : `No — this message is not on a subject the agent has spoken on here.`;
}
