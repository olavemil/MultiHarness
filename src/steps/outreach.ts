import { z } from "zod";
import type { ModelStep } from "./types.ts";

/**
 * Writes one unprompted message, to one target.
 *
 * **Split from `initiate` because there can be several.** Composing four
 * messages in one constrained decode produces four variations on one paragraph;
 * composing them separately produces four messages. `initiate` still decides
 * *whether* and commits to a one-line intent per target — that half cannot be
 * deferred, because "is this worth saying?" is unanswerable without knowing what
 * would be said — and this writes the text.
 *
 * **It is told who else is being written to**, through `${other_targets}`. Two
 * failures follow from not knowing: the same message goes to everybody, and the
 * agent tells one person something it is about to tell another as though it were
 * private. A person writing three messages in a sitting knows they are writing
 * three.
 *
 * For a person, the context is what the agent knows about *them* specifically —
 * `user_summary` and their impressions resolve to the target rather than to
 * whoever the session happens to be anchored on. For a channel it is that
 * channel's own recent history and its latest restatement of what it was doing.
 */
export interface Outreach {
  /** The message, exactly as it will be sent. */
  message: string;
}

const schema = z.object({ message: z.string() }) as z.ZodType<Outreach>;

export const outreach: ModelStep<Outreach> = {
  kind: "model",
  name: "outreach",
  defaultRole: "reasoning",
  voice: "agent",
  contextBlocks: [],
  // **The last thing said leads.** It is what an unprompted message can branch
  // *from*: "you were asking about X" continues a conversation, and the same
  // message without it lands out of nowhere. The restated history behind it is
  // what that conversation was actually working on.
  appendix: [
    "latest_message",
    "prior_request",
    "user_summary",
    "recent_messages",
    "background_thinking",
    "current_plan",
  ],
  outputFile: "outreach.md",
  buildSchema: () => schema,

  /**
   * Nothing. An unparsed message is not sent, and that is the right failure:
   * `initiate` already committed to speaking, but a garbled message is worse
   * than none, and the target cooldown is only stamped on a delivery.
   */
  fallback: () => ({ message: "" }),

  // **No tools, deliberately.** `initiate` already had them and used them to
  // decide; by here the question is settled and the target's own context —
  // their summary, that channel's transcript, its last restatement — is
  // supplied directly. A tool loop would double the calls per target for a
  // short message, and with three targets that is six extra round trips on the
  // large weights to compose three paragraphs.

  render: (o) => o.message || "_(nothing was sent)_",
};
