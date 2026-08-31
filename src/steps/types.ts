import type { z } from "zod";
import type { Config, RoleName } from "../config/schema.ts";
import type { BlockInput, Voice } from "../context/blocks/index.ts";
import type { CompletedStep } from "../core/types.ts";

/**
 * A step is a prompt file, a declared context spec, a model role, a tool
 * allowlist, and an output file. Adding one is a new file here, a prompt `.md`,
 * a registry line, and a config entry — never a branch in shared code.
 */

/** Template variables a step supplies beyond its context blocks. */
export type StepVariables = Record<string, string>;

export interface ModelStep<T> {
  kind: "model";
  name: string;
  /** Overridable per step in config; this is the step's own default. */
  defaultRole: RoleName;
  /**
   * Whether this step *is* the agent or judges it from outside.
   *
   * Not decoration. It picks the heading every appendix is labelled with, and
   * those headings are the only thing telling a local model that the research
   * summary in front of it is its own work rather than something the sender
   * wrote. It also fixes the prompt's grammatical person, which is load-bearing
   * in both directions: a classification prompt addressed as "you" makes the
   * model conflate "is this aimed at you" with "are you being asked this", and a
   * step asked "did *you* do well?" answers yes.
   */
  voice: Voice;
  /**
   * Mandatory blocks, referenced as `${name}` by the step's own frame.
   *
   * Keep this short. A step that declares one and is run without it fails
   * loudly, which is correct — it means the step was queued in a session that
   * cannot supply what it needs.
   */
  contextBlocks: readonly string[];
  /**
   * Optional blocks, highest priority first, assembled into `${context}` and
   * **omitted entirely when absent**.
   *
   * Order is by attention, not by budget: put first the block the step is most
   * likely to be wrong without. `respond` leads with `draft`, `reason` with what
   * research found, `restate` with a correction from `reflect`.
   */
  appendix?: readonly string[];
  /**
   * Built from config rather than fixed, so that constrained decoding can be
   * narrowed by configuration — `react` compiles the configured step vocabulary
   * into its schema, making an invalid step name undecodable rather than merely
   * discouraged.
   */
  buildSchema(config: Config, input: BlockInput): z.ZodType<T>;
  /** The documented safe default used when both attempts fail validation. */
  fallback(config: Config): T;
  outputFile: string;
  /** Parsed result -> the markdown sealed to `outputFile`. */
  render(parsed: T): string;
  variables?(config: Config, input: BlockInput): StepVariables;
  defaultTools?: readonly string[];
  /**
   * Receives a `${situation}` fragment chosen by the conversational position of
   * the incoming message, plus `${mentioned_other}`. Lets one prompt ask a
   * different specific question per situation instead of one vague question for
   * all of them, without duplicating the shared guidance into six files.
   */
  situational?: boolean;
}

export interface ComputeInput {
  sessionNumber: number;
  startedAt: number;
  completed: readonly CompletedStep[];
}

/** A step that produces output without calling a model. */
export interface ComputedStep {
  kind: "computed";
  name: string;
  outputFile: string;
  compute(input: ComputeInput): string | Promise<string>;
}

/** Heterogeneous registry entry; `any` is confined to this alias. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStep = ModelStep<any> | ComputedStep;
