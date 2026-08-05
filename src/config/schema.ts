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
  /** `-1` pins the model in memory. Passed through to ollama untouched. */
  keep_alive: z.union([z.number(), z.string()]).optional(),
  /** `false` disables thinking mode — how `digest` reuses the reasoning weights. */
  think: z.boolean().optional(),
  /** Hard-empty tool allowlist, enforced by the harness rather than by the prompt. */
  no_tools: z.boolean().default(false),
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
  base: z.number().min(0).max(1).default(0.3),
  /** Being named is not a probability. */
  mention: z.number().min(0).max(1).default(1),
  followup_multiplier: z.number().positive().default(2.5),
  model_yes_multiplier: z.number().positive().default(1.5),
  model_no_multiplier: z.number().positive().default(0.5),
  /** Messages examined for the agent's own share of the conversation. */
  presence_window: z.number().int().positive().default(12),
  /** Messages examined to count how many people are present. */
  participant_window: z.number().int().positive().default(24),
  damping_min: z.number().positive().default(0.25),
  damping_max: z.number().positive().default(2),
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
  }),

  ollama: z.object({
    host: z.string().min(1),
    request_timeout_ms: z.number().int().positive().default(300_000),
  }),

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
    /** Runs after `reflect_step`; decides whether to respond and what else to run. */
    entry_step: z.string().min(1),
    /**
     * Optional preparatory steps `entry_step` may choose from — research,
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
    /** Runs after the chosen steps whenever `entry_step` decided to reply. */
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
     * Ask a model which earlier message the incoming one replies to, and route
     * on that instead of on distance between messages. Costs one `fast` call.
     */
    reply_target: z.boolean().default(false),
    /**
     * How many impressions must accumulate before they are synthesised into the
     * identity's running summary. Synthesising after every exchange would
     * restate the latest one and call it a pattern.
     */
    impression_threshold: z.number().int().positive().default(5),
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
