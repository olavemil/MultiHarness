import { consoleAttached, sharedConsole } from "./adapters/console.ts";
import { discoverInstances, instanceRoot, selectInstances } from "./instance/discover.ts";
import { acquireLocks } from "./instance/lock.ts";
import { createLogger } from "./instance/log.ts";
import { startInstance, type RunningInstance } from "./instance/run.ts";

/**
 * How long a graceful stop waits for sessions already in flight.
 *
 * Bounded because a `research` step on the 27B can run for minutes, and an
 * operator who asked it to stop should not have to wait that out. Docker allows
 * ten seconds before SIGKILL and systemd ninety, so this sits inside the
 * tighter of the two.
 */
const GRACE_MS = 8_000;

/**
 * One process, every agent on the machine.
 *
 * They used to be one process each, which meant two agents on one laptop each
 * held their own copy of the model client and contended for the same weights
 * with no way to see it. `model/lease.ts` already serialises calls per model id
 * and excludes queued time from the session budget — it just could not reach
 * across process boundaries. Sharing the process is what turns it into the
 * cross-instance guarantee, with no change to the leasing code.
 *
 * **Nothing else is shared, and that is deliberate.** Instances do not know
 * about each other: separate config, working directory, stores, identities, and
 * secrets. There is no guarantee two of them even connect to the same Slack
 * workspace, so running them together is a resource decision — one machine, one
 * set of pinned models — and nothing semantic follows from it.
 *
 *   npm run dev                 # every instance under ~/.multiharness
 *   npm run dev -- galatea      # just that one
 *   MULTIHARNESS_HOME=… npm run dev
 */
async function main(): Promise<void> {
  const log = createLogger("daemon");

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  // Flags belong to node, not to us; anything else is an instance name.
  const requested = args.filter((arg) => !arg.startsWith("-"));

  const available = discoverInstances();
  if (available.length === 0) {
    throw new Error(
      `No agent instances found under ${instanceRoot()}. Run \`npm run init\` to create one.`,
    );
  }

  const chosen = selectInstances(available, requested);

  // Claimed before anything starts. Two daemons over one instance directory is
  // the case `model/lease.ts` cannot reach across and the knowledge gatekeeper
  // is not safe under — see `instance/lock.ts`.
  const locks = acquireLocks(chosen, force);
  process.on("exit", () => locks.release());

  log.log(`starting ${chosen.map((ref) => ref.name).join(", ")} as pid ${process.pid}`);

  /**
   * One process is one blast radius, so an instance that cannot start is
   * reported and skipped rather than taking the others down with it — the same
   * discipline the per-channel drain already applies to a failed session. A
   * missing Slack token is the likely cause and it is specific to one agent.
   */
  const running: RunningInstance[] = [];
  for (const ref of chosen) {
    try {
      running.push(
        await startInstance(ref, createLogger(ref.name), { shareConsole: chosen.length > 1 }),
      );
    } catch (cause) {
      log.error(`${ref.name} did not start: ${cause instanceof Error ? cause.message : cause}`);
    }
  }

  if (running.length === 0) throw new Error("No instance started. See the errors above.");

  // Only now does the terminal start reading. Attaching to it is passive, so a
  // message piped in cannot be delivered to whoever started first and missed by
  // everyone still starting — which looked exactly like the others declining to
  // answer, and would have been read as one.
  if (consoleAttached()) sharedConsole().ready();

  /**
   * Stop accepting, let what is in flight finish, and go.
   *
   * There were no signal handlers at all before this, so the OS default applied
   * and any supervisor's SIGTERM killed the process mid-session — losing work
   * that `RunningInstance.stop()` is written to drain. A second signal exits at
   * once, because an operator pressing Ctrl-C twice means it.
   *
   * Note what this cannot help with: **Ctrl-Z stops the process**, and a stopped
   * process runs no handlers, so a queued SIGTERM sits there until it is
   * continued. That is not a bug to fix here — `kill -CONT` first, or use
   * Ctrl-C.
   */
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      log.warn(`${signal} again — exiting now, in-flight work is abandoned`);
      process.exit(130);
    }
    stopping = true;
    log.log(`${signal} — finishing in-flight sessions (up to ${GRACE_MS}ms); signal again to exit now`);

    const drained = Promise.allSettled(running.map((instance) => instance.stop()));
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      drained,
      new Promise<typeof timedOut>((done) => setTimeout(() => done(timedOut), GRACE_MS).unref()),
    ]);
    if (outcome === timedOut) log.warn(`still working after ${GRACE_MS}ms; exiting anyway`);

    locks.release();
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // The console is the operator's handle on the whole daemon, so ending its
  // input ends the daemon. A Slack adapter's `closed()` only ever resolves from
  // its own `stop()`, so an all-Slack daemon runs until it is signalled —
  // which is what headless means.
  await Promise.race(running.map((instance) => instance.closed()));
  await Promise.all(running.map((instance) => instance.stop()));
  locks.release();
}

await main();
