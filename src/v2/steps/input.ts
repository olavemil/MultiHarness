import type { Principal } from "../compose/fragments.ts";
import type { WorkList } from "../work.ts";

/**
 * Everything a step may read, as typed values rather than pre-rendered
 * markdown.
 *
 * The distinction is the point. v1 blocks resolved to *strings* — already
 * formatted, already headed, already truncated — so a step received prose it
 * could only paste. Here a step receives the data and decides how it appears,
 * which is what lets the heading live next to the prompt that uses it.
 *
 * Optionality is real rather than decorative: an absent field is `undefined`,
 * and `cond && [...]` in a `context` array is how a step handles that. Nothing
 * substitutes placeholder prose on a step's behalf.
 */
export interface StepInput {
  principal: Principal;

  /** Who this session is talking to. Absent on a session no message triggered. */
  sender?: string;

  /** The literal incoming message. */
  message?: string;

  /** Oldest first. Empty in a channel with no history. */
  history: readonly { author: string; text: string }[];

  /** Sealed output of steps that already ran this session, in order. */
  completed: readonly { step: string; content: string }[];

  /** The previous session's sealed artifacts in this channel. */
  prior?: {
    request?: string;
    reflection?: string;
    review?: string;
    /** `reflect`'s finding that the previous session misread the question. */
    correction?: string;
  };

  /** What the agent itself last said here, however far back. */
  lastContribution?: { text: string; messagesSince: number };

  /** Accumulated impressions of the sender, oldest first. */
  impressions: readonly string[];

  /** The channel's durable plan, when one is running. */
  plan?: { goal: string; outstanding: readonly string[] };

  /**
   * Background work already queued.
   *
   * Read by `schedule_work` so it does not propose the same thing every
   * session, and by a working step so it knows what it is doing.
   */
  pendingWork?: WorkList;

  /** The item a background session is working on. Absent on a message session. */
  currentWork?: { kind: string; task: string; attempts: number };

  /** The agent's cross-channel background thinking, latest revision only. */
  thinking?: string;
}

/** Sealed output of one earlier step this session, if it ran. */
export function output(input: StepInput, step: string): string | undefined {
  return input.completed.find((c) => c.step === step)?.content.trim() || undefined;
}

/**
 * The transcript, newest last.
 *
 * The agent's own turns are labelled by name like everybody else's. Rendering
 * them as `you` made the transcript non-neutral for exactly the step that needs
 * it least biased, and forced one v1 prompt to open by disclaiming its own
 * input.
 */
export function transcript(input: StepInput, limit: number): string | undefined {
  const recent = input.history.slice(-limit);
  if (recent.length === 0) return undefined;
  return recent.map((m) => `${m.author}: ${m.text}`).join("\n");
}
