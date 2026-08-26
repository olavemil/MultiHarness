import { z } from "zod";

/**
 * Model roles. Steps name a role; this table is the only place a concrete model
 * id appears. Swapping a model, or defining an alternate profile, must never
 * require touching step config.
 */
export const ROLE_NAMES = ["fast", "reasoning", "digest", "embed"] as const;
export const RoleName = z.enum(ROLE_NAMES);
export type RoleName = z.infer<typeof RoleName>;

/** Sentinel for a role whose model id has not been filled in yet. */
export const PLACEHOLDER_MODEL = "PLACEHOLDER";

/** Values ollama accepts inside its `options` bag. */
const OptionValue = z.union([z.number(), z.string(), z.boolean()]);

export const RoleConfig = z.object({
  model: z.string().min(1),
  /**
   * Which model server this role's calls go to. `omlx` requires `[omlx]` to
   * be configured — checked at role resolution, the same way a placeholder
   * model is, rather than at config load, so a backend nothing uses yet
   * cannot block startup.
   */
  backend: z.enum(["ollama", "omlx"]).default("omlx"),
  /**
   * `-1` pins the model in memory. Passed through to ollama untouched.
   * Meaningless on `omlx`, which manages residency itself — `load.ts` warns
   * at startup rather than letting it silently do nothing, as it did for
   * `embed` before that was traced down.
   */
  keep_alive: z.union([z.number(), z.string()]).optional(),
  /** `false` disables thinking mode — how `digest` reuses the reasoning weights. */
  think: z.boolean().optional(),
  /** Hard-empty tool allowlist, enforced by the harness rather than by the prompt. */
  no_tools: z.boolean().default(false),
  /**
   * Run one call at a time on this model, queueing the rest.
   *
   * For the large weights. Two sessions reaching a `reasoning` step at once do
   * not get two models — ollama queues them behind each other — so both
   * deadlines run while only one call progresses and both can time out. Waiting
   * here instead makes the queue explicit, keeps it out of the timeout, and
   * staggers the answers so the second session can see the first.
   *
   * Leave it off for `fast`: `update` runs *alongside* the step it supervises,
   * and serialising them would deadlock the supervisor.
   */
  exclusive: z.boolean().default(false),
  options: z.record(z.string(), OptionValue).default({}),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

export const StepConfig = z.object({
  role: RoleName.optional(),
  timeout_ms: z.number().int().positive().optional(),
  tools: z.array(z.string()).optional(),
  options: z.record(z.string(), OptionValue).optional(),
  /**
   * Overrides the role's thinking setting. Thinking dominates wallclock and is
   * excluded from ollama's token counts, so a step that wants a fast direct
   * answer can switch it off without giving up the role's model.
   */
  think: z.boolean().optional(),
});
export type StepConfig = z.infer<typeof StepConfig>;

export const ParticipationConfig = z.object({
  /**
   * Off by default. Turning it on makes the decision stochastic, which changes
   * what the eval measures — run the suite with it disabled when judging a
   * prompt change, or the model's judgement is buried under the draw.
   */
  enabled: z.boolean().default(false),
  /**
   * Scale on the averaged coefficient. **1.0 means the weights are the
   * probability**, which is the property the whole scheme is calibrated on:
   * every measurement at its midpoint gives a 50% chance of replying, an agent
   * that has been too talkative falls proportionally below that, and interest
   * lifts it above. Lower this to make an agent quieter across the board
   * without disturbing the balance between the weights.
   */
  base: z.number().min(0).max(1).default(1),
  /** Being named is not a probability. */
  mention: z.number().min(0).max(1).default(1),
  /**
   * How hard a direct follow-up pulls the averaged coefficient toward neutral.
   *
   * Not a multiplier: it enters as `w` pseudo-observations of 1.0, so the
   * result moves toward 1 and can never be pushed past it. A larger weight
   * pulls harder. This rescues an agent the room terms have suppressed —
   * somebody just spoke to it, so crowding should stop mattering so much.
   */
  followup_weight: z.number().positive().default(2.5),
  /**
   * Applied when the arriving message continues a subject the agent has itself
   * spoken on, as measured by `core/standing.ts`.
   *
   * The same signal that routes `react` to its own-subject fragment, reused
   * here: having standing in a conversation should make the agent likelier to
   * take part in it, not merely likelier to judge that it could. In a
   * four-person room the crowd term alone halves every probability, which is
   * correct for chatter and wrong for the thread the agent is actually in.
   */
  own_subject_weight: z.number().positive().default(2),
  /**
   * The range `interest` is mapped onto. At 0..1 the weight *is* the interest,
   * so a step reporting 0.5 contributes 0.5 and the midpoint property holds.
   * Narrow the range to stop the model's judgement swinging the odds so far.
   */
  model_yes_weight: z.number().min(0).max(1).default(1),
  model_no_weight: z.number().min(0).max(1).default(0),
  /** Messages examined for the agent's own share of the conversation. */
  presence_window: z.number().int().positive().default(12),
  /** Messages examined to count how many people are present. */
  participant_window: z.number().int().positive().default(24),
  /**
   * Floor on the crowd term, so a very large room does not silence the agent
   * outright. `2 / participants`, clamped here and at 1.
   */
  crowd_min: z.number().positive().default(0.2),
  /**
   * Pause before working on a message nobody addressed, jittered by ±50%.
   *
   * Lets anyone else answer first — sibling instance or human alike — so that
   * several agents in a room stop racing to be first. Zero disables it. Being
   * named is never delayed.
   */
  interject_delay_ms: z.number().int().min(0).default(4_000),
  /**
   * Floor on presence damping. There is no ceiling parameter: every weight is
   * 0..1 by construction, which is what makes the average a blend and the
   * follow-up pull strictly upward.
   */
  damping_min: z.number().min(0).max(1).default(0.25),
  max: z.number().min(0).max(1).default(1),
});
export type ParticipationConfig = z.infer<typeof ParticipationConfig>;

export const Config = z.object({
  /** External working directory. `~` is expanded. Never inside the repo. */
  working_dir: z.string().min(1),

  /**
   * Who the agent is. Steps need this to tell a message addressed to them from
   * one addressed to someone else in the same channel — the single highest-value
   * judgement `react` makes.
   */
  agent: z.object({
    name: z.string().min(1),
    /** Including @mention forms. */
    aliases: z.array(z.string()).default([]),
    /**
     * A short descriptor of what this agent is like, rendered into the frame of
     * every subjective step as `${agent_persona}`.
     *
     * A phrase, not a paragraph: it sits inside a sentence — *"You are galatea,
     * ${agent_persona}."* — and every word of it is paid for on every reasoning
     * call in the session.
     *
     * Static, and deliberately so for now. The self-revising version is a
     * cross-channel document the agent edits about itself, which makes it the
     * second loop in the system whose mistakes do not expire; it wants the same
     * guards impressions have — append-only revisions and a strong default of
     * leaving it alone — rather than being bolted onto a config string.
     */
    personality: z.string().default("a careful, direct participant in this conversation"),
  }),

  ollama: z.object({
    host: z.string().min(1),
    request_timeout_ms: z.number().int().positive().default(300_000),
  }),

  /**
   * oMLX (github.com/jundot/omlx), an Apple-Silicon-only inference server with
   * an OpenAI-compatible API. Optional: a role only needs this table when its
   * own `backend` names `"omlx"`. Absent by default, like every `[roles.*]`
   * being on `ollama` by default — nothing here assumes a second server exists.
   */
  omlx: z
    .object({
      host: z.string().min(1),
      request_timeout_ms: z.number().int().positive().default(300_000),
    })
    .optional(),

  roles: z.record(z.string(), RoleConfig),

  context: z.object({
    /** Budget applied to any block without an explicit entry below. */
    default_budget_tokens: z.number().int().positive().default(1_000),
    budgets: z.record(z.string(), z.number().int().positive()).default({}),
  }),

  session: z.object({
    /**
     * Opens the session by judging how the previous one landed. Queued only
     * when this channel has a previous session — there is nothing to reflect on
     * before that.
     */
    reflect_step: z.string().min(1),
    /**
     * Reads the arriving message from outside the conversation: which message it
     * replies to, who it is aimed at, and what it wants back. Purely objective,
     * and it absorbed what used to be a separate `reply_target` call, so the
     * entry path still costs two `fast` calls.
     *
     * Skipped entirely when the agent was named — being named settles the reply,
     * and nothing else this produces is used on that path.
     */
    read_step: z.string().min(1),
    /**
     * Asks the agent itself whether it has anything worth saying. The one
     * subjective step on the entry path, and the only consumer of the situation
     * fragments.
     *
     * Its `interest` is a weight, not a verdict — the verdict is derived in
     * `steps/verdict.ts` from this, the reading, and the participation draw.
     */
    stance_step: z.string().min(1),
    /**
     * Optional preparatory steps `schedule_step` may choose from — research,
     * reason, draft, and so on as they land. This list is compiled into the
     * JSON Schema handed to the model, so constrained decoding cannot emit a
     * step that does not exist. Empty means "decide only whether to reply".
     */
    selectable_steps: z.array(z.string()),
    /**
     * Boils the conversation down to a self-contained statement of what is
     * being asked, sealed and exposed to later steps as the `request` block.
     * Runs after a reply has been decided on, and only when there is history to
     * boil down. Empty disables it.
     */
    restate_step: z.string().default(""),
    /**
     * Chooses which steps run in this session, once a reply is decided on.
     * Runs only when there are `selectable_steps` to choose between. Distinct
     * from the durable planning document, which is not this.
     */
    schedule_step: z.string().min(1),
    /** Runs after the chosen steps whenever the derived verdict is `reply`. */
    respond_step: z.string().min(1),
    /** Always appended, whether or not the agent chose to respond. */
    closing_steps: z.array(z.string()).min(1),
    /**
     * Writes and revises the channel's durable, cross-session plan. The only
     * step whose output the harness applies to `channels/<id>/plans/`. Empty
     * disables planning entirely.
     */
    plan_step: z.string().default("plan"),
    /**
     * Judges how the session handled messages that arrived while it was
     * working, and reports anything left unanswered. Queued only when something
     * actually arrived — most sessions are never interrupted. Empty disables it.
     */
    debrief_step: z.string().default(""),
    /**
     * Sessions with no incoming message, run when a channel has gone quiet.
     *
     * The sleep phase: retrospective work belongs in idle time rather than on
     * the reply path, where it costs somebody a wait. Fires only when there is
     * actually work to do — a maintenance session with nothing in it is pure
     * cost, which is the same argument that keeps `restate` off the declining
     * path.
     */
    maintenance: z
      .object({
        enabled: z.boolean().default(false),
        /** Quiet time in a channel before one fires. */
        idle_ms: z.number().int().positive().default(900_000),
        /**
         * What a maintenance session runs. `respond` is refused here whatever
         * this says — nobody is waiting, and speaking would be the agent
         * talking to itself.
         */
        steps: z.array(z.string()).default(["impression"]),
      })
      .default(() => ({ enabled: false, idle_ms: 900_000, steps: ["impression"] })),
    /**
     * Carrying on with an unfinished plan after a reply has gone out.
     *
     * Bounded by a hard iteration cap rather than by a judgement, and stopped
     * the moment an iteration closes nothing. Both are countable; neither is
     * asked of a model.
     */
    continuation: z
      .object({
        enabled: z.boolean().default(false),
        /**
         * Work done each iteration, before `plan` revises. `respond` is refused
         * whatever this says: a continuation reports through the plan, and a
         * reply to nobody would be the agent talking to itself.
         */
        steps: z.array(z.string()).default(["reason"]),
        /** Hard cap on iterations per reply. Reaching it is plan failure. */
        max_iterations: z.number().int().positive().default(3),
      })
      .default(() => ({ enabled: false, steps: ["reason"], max_iterations: 3 })),
    max_wallclock_ms: z.number().int().positive().default(900_000),
    /**
     * Model and tool calls a session may spend. Wallclock alone is not a bound:
     * a single step's timeout can exceed it, and `plan` can queue several
     * expensive steps at once.
     */
    max_model_calls: z.number().int().positive().default(24),
    max_tool_calls: z.number().int().positive().default(24),
    // Zod 4 wants a complete default object; derive it from the schema so the
    // defaults live in exactly one place.
    participation: ParticipationConfig.default(() => ParticipationConfig.parse({})),
    /**
     * Whether an arriving message continues a subject the agent has itself
     * spoken on, measured as cosine similarity against its own recent turns.
     *
     * Settled in code because the model could not settle it: decoded as a
     * boolean on `fast` it scored 0/3, and on a 27B 3/3 at thirty times the
     * latency. See `core/standing.ts`.
     */
    /**
     * How many sessions may run at once across the whole daemon.
     *
     * One, because two agents share one GPU: `model/lease.ts` serialises calls
     * on the same model id, which leaves the case that actually bites — a 27B
     * step in one instance starving `fast` in another. Held for a whole session
     * and granted FIFO, so the message that arrived first is answered first
     * rather than every session finishing late together.
     */
    turn: z
      .object({ size: z.number().int().positive().default(1) })
      .default(() => ({ size: 1 })),
    standing: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Cosine above which the message counts as the agent's subject.
         * Calibrated against `eval/cases/react.json`, not chosen by taste.
         */
        threshold: z.number().min(0).max(1).default(0.4),
        /** How many of the agent's own recent turns to compare against. */
        turns: z.number().int().positive().default(4),
      })
      .default(() => ({ enabled: true, threshold: 0.4, turns: 4 })),
    /**
     * How much the agent must have to add before it speaks up when nothing was
     * asked of anybody — `stance`'s `interest`, on its own 0..1 scale, where
     * 0.5 is "could say something relevant, but nobody would miss it".
     *
     * It does two jobs, and the second is what fixes the mention loop:
     *
     * - Below it, a message that asked nothing gets no written reply. Where the
     *   agent was *named*, that becomes an acknowledgement rather than silence,
     *   so a bare `@harness good point` is marked instead of answered.
     * - Below it, a reply that does get written may not name anybody. A reply
     *   that names somebody compels a reply, so an agent with little to say
     *   naming the person it answers keeps an exchange alive that nobody chose.
     *
     * A question is answered whatever this is set to. Raising it makes the
     * agent quieter in exchanges it was only mentioned in passing in; setting
     * it to 0 restores the previous behaviour, where any interest above nothing
     * was enough.
     */
    min_interest: z.number().min(0).max(1).default(0.3),
    /**
     * How many impressions must accumulate before they are synthesised into the
     * identity's running summary. Synthesising after every exchange would
     * restate the latest one and call it a pattern.
     */
    impression_threshold: z.number().int().positive().default(5),
    /**
     * Whether the agent may start a conversation nobody asked it to.
     *
     * **The only thing here that writes to a channel unprompted**, and the one
     * feature most likely to be regretted, so every bound is countable and lives
     * in `core/initiative.ts` rather than in a prompt a model can reason around.
     */
    initiative: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Past this much silence a channel is a fresh start: the agent may speak
         * even if it had the last word, because hours have gone by.
         */
        free_after_ms: z.number().int().positive().default(21_600_000),
        /**
         * Between this and `free_after_ms`, speaking is allowed unless the agent
         * already sent the last two messages — a third would be three in a row.
         *
         * Sooner than this the conversation is still live, and the only bar is
         * that somebody else spoke last. **A ladder rather than one cutoff**,
         * because how much silence excuses speaking depends on who has been
         * doing the talking: a flat threshold both blocks the agent from picking
         * up a conversation it has a place in and lets it monologue into a room
         * where nobody has answered it twice already.
         */
        recent_after_ms: z.number().int().positive().default(3_600_000),
        /**
         * And how quiet is too quiet. A room nobody has touched in a fortnight
         * is not waiting to be reopened, it is over.
         *
         * Easy to leave out and load-bearing: the survey sorts by silence, so
         * without an upper bound the deadest channel is permanently the most
         * eligible one.
         */
        max_silent_ms: z.number().int().positive().default(1_209_600_000),
        /**
         * Minimum gap between one unprompted message and the next, **across
         * every channel**. Per-channel would let an agent with six rooms open
         * six conversations at once.
         */
        cooldown_ms: z.number().int().positive().default(21_600_000),
        /**
         * Only speak up in rooms the agent has already taken part in. Starting a
         * conversation somewhere it has never said anything is the worst version
         * of this feature.
         */
        require_history: z.boolean().default(true),
        /**
         * Gap before going back to the *same* target, on top of the global
         * cooldown. Without it the agent may open something in one room every
         * time the global cooldown lapses, which reads as pestering even when
         * each message is individually fine.
         */
        target_cooldown_ms: z.number().int().positive().default(259_200_000),
        /**
         * Whether it may write to people directly, not just into channels.
         *
         * A DM is more intrusive than a message in a room somebody can ignore,
         * so this is separable from the feature as a whole.
         */
        dm_enabled: z.boolean().default(true),
        /**
         * How long since somebody last said anything, anywhere, before the agent
         * stops writing to them.
         *
         * The DM equivalent of `max_silent_ms`, and the same trap: without it the
         * least active contact on file is permanently the most eligible, and
         * messaging somebody who left months ago is worse than messaging nobody.
         */
        dm_stale_ms: z.number().int().positive().default(2_592_000_000),
      })
      .default(() => ({
        enabled: true,
        free_after_ms: 21_600_000,
        recent_after_ms: 3_600_000,
        max_silent_ms: 1_209_600_000,
        cooldown_ms: 21_600_000,
        require_history: true,
        target_cooldown_ms: 259_200_000,
        dm_enabled: true,
        dm_stale_ms: 2_592_000_000,
      })),
    /**
     * What the agent noticed it does not know, accumulated across channels, and
     * what it does about it when nobody is talking to it.
     *
     * This is the only thing in the harness that makes the agent *want*
     * something. Everything else is reactive: a message arrives, a session runs.
     * Knowledge and impressions persist but neither drives anything — they are
     * read when something else has already started.
     */
    curiosity: z
      .object({
        enabled: z.boolean().default(true),
        /**
         * Cosine above which a new open question is the same one asked
         * differently, and is merged rather than recorded again.
         *
         * Merging is what makes recurrence countable, and recurrence is the
         * whole signal. Shares the hazard `[session.standing] threshold` has:
         * absolute cosine on short strings clusters far below 1, so the band is
         * specific to the embedding model and wants re-measuring if it changes.
         */
        merge_threshold: z.number().min(0).max(1).default(0.6),
        /**
         * How many times a question must have come up before an idle agent goes
         * and works on it. 1 pursues everything it ever noticed.
         */
        pursue_after: z.number().int().positive().default(2),
        /**
         * Recurrences after which pursuing has evidently not settled it, and it
         * becomes a plan in the channel it came from — at which point the
         * existing continuation machinery carries it across sessions.
         *
         * A plan is a commitment later sessions act on unprompted, so this is
         * deliberately well above `pursue_after`: something has to keep coming
         * back *and* survive being looked into before it earns one.
         */
        escalate_after: z.number().int().positive().default(4),
        /** Most shown to any step at once. These are read, not exhaustively. */
        max_open: z.number().int().positive().default(12),
      })
      .default(() => ({
        enabled: true,
        merge_threshold: 0.6,
        pursue_after: 2,
        escalate_after: 4,
        max_open: 12,
      })),
    /**
     * Emoji the agent marks a message with when an acknowledgement is wanted
     * and a written reply is not. Empty means stay silent.
     *
     * Now the **fallback** rather than the only option: `acknowledgements`
     * below gives the agent a vocabulary to pick from, and this is what a parse
     * failure, an unrecognised choice, or an empty vocabulary degrades to. It
     * must therefore stay something that is never wrong.
     */
    acknowledge_emoji: z.string().default("+1"),
    /**
     * Marked on the message while preparatory work runs, when `schedule` names
     * nothing better. Empty means stay unmarked.
     *
     * The reply stops being immediate the moment any step is scheduled —
     * `research` and `reason` run on `reasoning` for tens of seconds to minutes
     * — and until now the person saw nothing at all in that window. A person
     * about to go away and think marks the message first.
     */
    working_emoji: z.string().default("eyes"),
    /**
     * Emoji the agent might mark a message with, and when. Name (no colons) to
     * the situation it fits.
     *
     * **Suggestions, not a vocabulary.** These are rendered into `stance`'s
     * prompt; the schema takes any string. Compiling them into the schema meant
     * the agent could only pick from a list somebody wrote for it, which is
     * safe and is also why it never read like a person reacting — a person
     * picks the emoji they mean, and sometimes picks one that does not exist.
     * Slack answers that with `invalid_name`, which the adapter catches.
     *
     * **The descriptions live here rather than in the prompt**, which departs
     * from how `selectable_steps` works, and deliberately: this list is a
     * property of a *workspace* (custom emoji differ per Slack) so a meaning
     * that does not travel with its emoji would be wrong the moment anybody
     * edited the list.
     */
    acknowledgements: z.record(z.string(), z.string()).default(() => ({})),
  }),

  /**
   * Slack transport. Tokens are read from $SLACK_BOT_TOKEN and
   * $SLACK_APP_TOKEN — never from config, which ships with the repo.
   */
  slack: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * `separate` gives each thread its own channel, so per-channel history and
       * reflection follow one conversation instead of an interleaving.
       */
      thread_mode: z.enum(["separate", "shared"]).default("separate"),
    })
    .default(() => ({ enabled: false, thread_mode: "separate" as const })),

  /** Outbound HTTP, for the retrieval tools. */
  web: z
    .object({
      /**
       * Empty means any public host. Private and link-local addresses are
       * refused regardless — that is not configurable, because the daemon runs
       * beside ollama on localhost.
       */
      allowed_hosts: z.array(z.string()).default([]),
      user_agent: z.string().default("MultiHarness/0.1 (local agent harness)"),
    })
    .default(() => ({ allowed_hosts: [], user_agent: "MultiHarness/0.1 (local agent harness)" })),

  steps: z.record(z.string(), StepConfig).default({}),
});
export type Config = z.infer<typeof Config>;
