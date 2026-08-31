import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { InstanceRef } from "./discover.ts";

/**
 * One daemon per instance directory, enforced with a lock file.
 *
 * **This is a correctness guard, not tidiness.** Two daemons over the same
 * instance are exactly the case the rest of the design assumes away:
 * `model/lease.ts` serialises calls per model id but cannot reach across
 * processes, so both would contend invisibly on the same weights; and the
 * knowledge gatekeeper's read-then-write stops being safe, since `node:sqlite`
 * only makes it atomic *within* a process. Per-channel history has a single
 * writer for the same reason.
 *
 * The lock is per instance rather than per machine, because that is what is
 * actually being claimed: `npm run dev` and `npm run dev galatea` conflict only
 * over `galatea`, and should say so rather than refusing on principle.
 *
 * **PID reuse is not ruled out.** A stale file whose pid has been recycled onto
 * an unrelated process reads as live and refuses a legitimate start. `startedAt`
 * makes that diagnosable and `--force` is the way through; a real fix needs an
 * OS lock (`flock`) and is not worth the dependency yet.
 */

const LOCK_FILE = "daemon.pid";

/** A lock written before `host` existed, or by something that did not set it. */
const UNKNOWN_HOST = "(unrecorded)";

export interface LockHolder {
  pid: number;
  /**
   * Where that pid means something.
   *
   * PIDs are namespaced per container, so a daemon on the host and one in a
   * container read each other's locks as numbers from their own namespace —
   * `isAlive` then answers confidently and wrongly, in either direction. A lock
   * from elsewhere is therefore refused on sight rather than probed.
   */
  host: string;
  startedAt: string;
  /** Every instance that daemon claimed, for a message that names the whole set. */
  instances: string[];
}

const lockPath = (home: string): string => path.join(home, LOCK_FILE);

/** Whether a pid is a live process. Says nothing about *which* process. */
export function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks and delivers nothing.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means it exists and belongs to somebody else, which still counts.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder recorded for an instance, if the file exists and parses. */
export function readLock(home: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(home), "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      // **Missing means unknown, never "mine".** Defaulting to our own hostname
      // was tried and is unsafe: a container reading a host daemon's older lock
      // called it local, found the pid dead in its own namespace, and started a
      // second daemon over the same instances. Verified live, once.
      //
      // Refusing an unknown lock costs one `--force` after a crash, which is
      // loud and recoverable. The permissive reading costs invisible model
      // contention and a knowledge store with two writers.
      host: typeof parsed.host === "string" ? parsed.host : UNKNOWN_HOST,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
      instances: Array.isArray(parsed.instances) ? parsed.instances : [],
    };
  } catch {
    // Absent, unreadable, or truncated — all mean "nobody is holding this".
    return undefined;
  }
}

export class InstanceLockedError extends Error {
  readonly instance: string;
  readonly holder: LockHolder;

  constructor(instance: string, holder: LockHolder) {
    const elsewhere = holder.host !== hostname();
    super(
      `${instance} is already being run by pid ${holder.pid} on ${holder.host} ` +
        `(started ${holder.startedAt}, hosting ${holder.instances.join(", ") || instance}).` +
        (elsewhere
          ? ` This one is ${hostname()}, and a pid from another host or container means nothing ` +
            `here — stop that daemon where it runs, or pass --force if you are certain it is gone.`
          : ` Stop it with \`npm run stop\`, or pass --force if you are certain that process is gone.`),
    );
    this.name = "InstanceLockedError";
    this.instance = instance;
    this.holder = holder;
  }
}

export interface Locks {
  /** Removes every lock this process took. Safe to call more than once. */
  release(): void;
}

/**
 * Claims every instance or none.
 *
 * All-or-nothing because a daemon that started half its agents and refused the
 * rest is the confusing outcome: the operator sees it running and assumes it is
 * running everything.
 *
 * Writes synchronously so `release()` can be called from an `exit` handler,
 * where nothing asynchronous will ever run.
 */
export function acquireLocks(refs: readonly InstanceRef[], force = false): Locks {
  if (!force) {
    for (const ref of refs) {
      const holder = readLock(ref.home);
      // A lock from another host is refused **regardless of liveness**: its pid
      // is a number from a namespace this process cannot see into, so `isAlive`
      // would be guessing either way — and guessing wrong in the permissive
      // direction puts two daemons on one instance directory, which is the one
      // thing this file exists to prevent.
      if (holder && (holder.host !== hostname() || isAlive(holder.pid))) {
        throw new InstanceLockedError(ref.name, holder);
      }
    }
  }

  const record: LockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    instances: refs.map((ref) => ref.name),
  };
  const taken: string[] = [];
  for (const ref of refs) {
    writeFileSync(lockPath(ref.home), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    taken.push(ref.home);
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      for (const home of taken) {
        // Only ever remove our own: a `--force` start has already overwritten
        // the previous holder's file, and releasing somebody else's would be
        // worse than leaving a stale one behind.
        if (readLock(home)?.pid !== process.pid) continue;
        try {
          unlinkSync(lockPath(home));
        } catch {
          // Already gone. Nothing to do and nothing worth reporting.
        }
      }
    },
  };
}

/** Live daemons across the given instances, deduplicated by pid. */
export function runningDaemons(refs: readonly InstanceRef[]): LockHolder[] {
  const byPid = new Map<number, LockHolder>();
  for (const ref of refs) {
    const holder = readLock(ref.home);
    // Only daemons this process could actually signal — `npm run stop` cannot
    // reach into a container, and reporting one it cannot stop is worse than
    // saying nothing.
    if (!holder || holder.host !== hostname()) continue;
    if (isAlive(holder.pid) && !byPid.has(holder.pid)) byPid.set(holder.pid, holder);
  }
  return [...byPid.values()];
}
