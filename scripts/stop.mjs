#!/usr/bin/env node
/**
 * Stops the running daemon, or reports that there is none.
 *
 * The problem this solves is not killing a process — it is *finding* it. A
 * daemon outlives the terminal that started it by design, so "is one already
 * running, and which is it?" had no answer short of `pgrep`, and an orphan can
 * sit there holding Slack sockets for hours before anyone notices.
 *
 *   npm run stop              # every daemon holding an instance here
 *   npm run stop -- galatea   # only the daemon hosting that one
 *
 * SIGTERM, so the daemon drains what is in flight. `--now` sends SIGKILL
 * instead, which abandons it.
 */
import { discoverInstances, selectInstances } from "../src/instance/discover.ts";
import { isAlive, runningDaemons } from "../src/instance/lock.ts";

const args = process.argv.slice(2);
const now = args.includes("--now");
const names = args.filter((arg) => !arg.startsWith("-"));

const available = discoverInstances();
const chosen = names.length > 0 ? selectInstances(available, names) : available;
const daemons = runningDaemons(chosen);

if (daemons.length === 0) {
  console.log("No daemon is running for", chosen.map((ref) => ref.name).join(", ") || "(nothing)");
  process.exit(0);
}

const signal = now ? "SIGKILL" : "SIGTERM";
for (const daemon of daemons) {
  console.log(
    `${signal} -> pid ${daemon.pid} (started ${daemon.startedAt}, hosting ${daemon.instances.join(", ")})`,
  );
  try {
    process.kill(daemon.pid, signal);
  } catch (cause) {
    console.error(`  could not signal it: ${String(cause)}`);
  }
}

if (now) process.exit(0);

// Report what actually happened rather than assuming the signal landed. A
// stopped process — one that was Ctrl-Z'd — queues SIGTERM without ever running
// its handler, which is exactly how an orphan survives being "stopped".
const deadline = Date.now() + 12_000;
while (Date.now() < deadline) {
  const left = daemons.filter((daemon) => isAlive(daemon.pid));
  if (left.length === 0) {
    console.log("stopped");
    process.exit(0);
  }
  await new Promise((done) => setTimeout(done, 300));
}

const stubborn = daemons.filter((daemon) => isAlive(daemon.pid));
console.error(
  `still running after 12s: ${stubborn.map((d) => d.pid).join(", ")}.\n` +
    `If it was suspended with Ctrl-Z it cannot handle signals — \`kill -CONT <pid>\` first, ` +
    `or \`npm run stop -- --now\` to SIGKILL it.`,
);
process.exit(1);
