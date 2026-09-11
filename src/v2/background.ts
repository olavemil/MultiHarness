import type { Config } from "../config/schema.ts";
import type { Identity } from "../core/types.ts";
import type { Paths } from "../store/paths.ts";
import { readRecent } from "../store/channelStore.ts";
import { createSession, sealStep, type SessionHandle } from "../store/sessionStore.ts";
import { loadThinking } from "../store/thinkingStore.ts";
import { toStepInput } from "./bridge.ts";
import { onBackground } from "./pipeline.ts";
import { runV2Session } from "./run.ts";
import { loadWorkList } from "./workStore.ts";
import type { WorkItem } from "./work.ts";

/**
 * One background session: work on one item, then decide what is next.
 *
 * **Deliberately not `runSession`.** A background run has no message, no reply
 * path, no supervisor and no verdict, so routing it through the v1 runner would
 * mean threading a fourth trigger kind through 1,600 lines that assume a
 * channel exchange. The session *directory* is shared, which is the part that
 * matters for reading the results.
 */

export interface BackgroundOptions {
  config: Config;
  paths: Paths;
  channelId: string;
  identity: Identity;
  item: WorkItem;
  onProgress?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface BackgroundResult {
  session: SessionHandle;
  /** Whether the item reported itself done. The attempt cap decides the rest. */
  finished: boolean;
  proposed: Omit<WorkItem, "attempts">[];
}

export async function runV2Background(opts: BackgroundOptions): Promise<BackgroundResult> {
  const { config, paths, channelId, identity, item } = opts;

  const session = await createSession(paths);
  const history = await readRecent(paths, channelId, 20);
  const pendingWork = await loadWorkList(paths);
  const thinking = (await loadThinking(paths))?.text;

  const base = toStepInput({
    config,
    channelName: channelId,
    identity,
    history,
  });

  const result = await runV2Session({
    config,
    pipeline: onBackground,
    sessionId: session.id,
    channelId,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    input: {
      ...base,
      currentWork: { kind: item.kind, task: item.task, attempts: item.attempts },
      pendingWork,
      ...(thinking ? { thinking } : {}),
    },
  });

  for (const step of result.steps) {
    await sealStep(session, step.outputFile, step.content);
  }

  // Read from the note the step recorded rather than re-parsing its markdown.
  // Absent means the step did not run or could not be parsed, and "not
  // finished" is the safe reading: the item stays, and the cap closes it.
  return {
    session,
    finished: result.notes.finished === "true",
    proposed: result.proposed,
  };
}
