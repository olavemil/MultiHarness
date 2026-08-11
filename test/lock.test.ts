import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLocks,
  InstanceLockedError,
  isAlive,
  readLock,
  runningDaemons,
} from "../src/instance/lock.ts";
import { hostname } from "node:os";
import type { InstanceRef } from "../src/instance/discover.ts";

/**
 * One daemon per instance directory.
 *
 * A correctness guard rather than tidiness: two daemons over one instance is
 * the case `model/lease.ts` cannot reach across, and the knowledge gatekeeper's
 * read-then-write is only atomic within a process.
 */

let root: string;
const refs: InstanceRef[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "multiharness-lock-"));
  refs.length = 0;
  for (const name of ["galatea", "nephele"]) {
    const home = path.join(root, name);
    await mkdir(home, { recursive: true });
    refs.push({ name, home });
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A pid that is certainly not a live process. */
const DEAD_PID = 0x7ffffff;

const lockFile = (ref: InstanceRef) => path.join(ref.home, "daemon.pid");

describe("acquiring the lock", () => {
  it("records this process against every instance it claims", () => {
    const locks = acquireLocks(refs);
    for (const ref of refs) {
      const holder = readLock(ref.home);
      expect(holder?.pid).toBe(process.pid);
      // Every instance names the whole set, so one file explains the daemon.
      expect(holder?.instances).toEqual(["galatea", "nephele"]);
    }
    locks.release();
  });

  it("refuses when another live daemon already holds one", () => {
    const first = acquireLocks(refs);
    try {
      expect(() => acquireLocks(refs)).toThrowError(InstanceLockedError);
      // The message has to name the instance and the pid, because "already
      // running" without either sends you to `pgrep`.
      expect(() => acquireLocks(refs)).toThrowError(/galatea/);
      expect(() => acquireLocks(refs)).toThrowError(new RegExp(String(process.pid)));
    } finally {
      first.release();
    }
  });

  it("refuses on the overlap only", () => {
    // `npm run dev` and `npm run dev galatea` conflict over galatea and nothing
    // else; a lock per machine would refuse starts that are perfectly fine.
    const held = acquireLocks([refs[0] as InstanceRef]);
    try {
      expect(() => acquireLocks([refs[1] as InstanceRef])).not.toThrow();
      expect(() => acquireLocks(refs)).toThrowError(/galatea/);
    } finally {
      held.release();
    }
  });

  it("claims all or nothing", async () => {
    // A daemon that started half its agents and refused the rest is the
    // confusing outcome: it looks like it is running everything.
    const other = acquireLocks([refs[1] as InstanceRef]);
    try {
      expect(() => acquireLocks(refs)).toThrowError(InstanceLockedError);
      expect(existsSync(lockFile(refs[0] as InstanceRef))).toBe(false);
    } finally {
      other.release();
    }
  });

  it("steps over a lock whose process is gone", async () => {
    // The normal aftermath of a SIGKILL or a crash. A stale file must not need
    // manual cleanup before the daemon will start again.
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({
        pid: DEAD_PID,
        host: hostname(),
        startedAt: "yesterday",
        instances: ["galatea"],
      }),
      "utf8",
    );

    const locks = acquireLocks(refs);
    expect(readLock((refs[0] as InstanceRef).home)?.pid).toBe(process.pid);
    locks.release();
  });

  it("steps over a file it cannot read", async () => {
    await writeFile(lockFile(refs[0] as InstanceRef), "{ truncated", "utf8");
    expect(readLock((refs[0] as InstanceRef).home)).toBeUndefined();
    const locks = acquireLocks(refs);
    expect(readLock((refs[0] as InstanceRef).home)?.pid).toBe(process.pid);
    locks.release();
  });

  it("takes it anyway under --force", () => {
    const first = acquireLocks(refs);
    try {
      const forced = acquireLocks(refs, true);
      expect(readLock((refs[0] as InstanceRef).home)?.pid).toBe(process.pid);
      forced.release();
    } finally {
      first.release();
    }
  });
});

describe("a lock written somewhere else", () => {
  // PIDs are namespaced per container, so a daemon on the host and one in a
  // container read each other's locks as numbers from their own namespace.
  // `isAlive` then answers confidently and wrongly in *either* direction, and
  // wrong-and-permissive means two daemons over one instance directory.
  const elsewhere = { pid: process.pid, host: "some-container", startedAt: "now" };

  it("is refused even though the pid looks alive here", async () => {
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({ ...elsewhere, instances: ["galatea"] }),
      "utf8",
    );
    expect(() => acquireLocks(refs)).toThrowError(InstanceLockedError);
    expect(() => acquireLocks(refs)).toThrowError(/some-container/);
  });

  it("is refused even though the pid looks dead here", async () => {
    // The dangerous direction: a live container daemon whose pid happens not to
    // exist on this host would otherwise read as a stale lock and be stepped on.
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({ pid: DEAD_PID, host: "some-container", startedAt: "now", instances: [] }),
      "utf8",
    );
    expect(() => acquireLocks(refs)).toThrowError(InstanceLockedError);
  });

  it("is not reported as something `npm run stop` could signal", async () => {
    // Reporting a daemon it cannot reach is worse than saying nothing.
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({ ...elsewhere, instances: ["galatea"] }),
      "utf8",
    );
    expect(runningDaemons(refs)).toEqual([]);
  });

  it("records this host when taking the lock", () => {
    const locks = acquireLocks(refs);
    expect(readLock((refs[0] as InstanceRef).home)?.host).toBe(hostname());
    locks.release();
  });

  it("refuses a lock with no host at all rather than assuming it is ours", async () => {
    // Found live: the container read a host daemon's older lock as local, saw a
    // pid that was dead *in its own namespace*, stepped over it, and started a
    // second daemon over the same instances. Unknown origin must not read as
    // mine — refusing costs one `--force`, the alternative costs two writers on
    // one knowledge store.
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({ pid: DEAD_PID, startedAt: "yesterday", instances: ["galatea"] }),
      "utf8",
    );
    expect(() => acquireLocks(refs)).toThrowError(InstanceLockedError);
    // And --force is the documented way through.
    const forced = acquireLocks(refs, true);
    expect(readLock((refs[0] as InstanceRef).home)?.pid).toBe(process.pid);
    forced.release();
  });
});

describe("releasing the lock", () => {
  it("removes the files it wrote", () => {
    acquireLocks(refs).release();
    for (const ref of refs) expect(existsSync(lockFile(ref))).toBe(false);
  });

  it("is safe to call twice", () => {
    const locks = acquireLocks(refs);
    locks.release();
    expect(() => locks.release()).not.toThrow();
  });

  it("leaves somebody else's lock alone", async () => {
    // After a `--force` start the previous holder still calls `release()`, and
    // it must not remove the file the new daemon now owns.
    const locks = acquireLocks(refs);
    await writeFile(
      lockFile(refs[0] as InstanceRef),
      JSON.stringify({ pid: DEAD_PID, startedAt: "now", instances: ["galatea"] }),
      "utf8",
    );

    locks.release();
    expect(existsSync(lockFile(refs[0] as InstanceRef))).toBe(true);
    expect(existsSync(lockFile(refs[1] as InstanceRef))).toBe(false);
  });
});

describe("finding what is running", () => {
  it("reports one entry per daemon, not per instance", () => {
    const locks = acquireLocks(refs);
    try {
      const found = runningDaemons(refs);
      expect(found).toHaveLength(1);
      expect(found[0]?.pid).toBe(process.pid);
    } finally {
      locks.release();
    }
  });

  it("reports nothing when the pids are dead", async () => {
    for (const ref of refs) {
      await writeFile(
        lockFile(ref),
        JSON.stringify({ pid: DEAD_PID, startedAt: "yesterday", instances: [ref.name] }),
        "utf8",
      );
    }
    expect(runningDaemons(refs)).toEqual([]);
  });
});

describe("isAlive", () => {
  it("knows this process is running", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("knows a dead pid is not", () => {
    expect(isAlive(DEAD_PID)).toBe(false);
  });
});
