import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverInstances, selectInstances } from "../src/instance/discover.ts";
import { parseEnv, readInstanceEnv } from "../src/instance/env.ts";
import { createLogger } from "../src/instance/log.ts";

/**
 * Several agents in one process.
 *
 * They share the machine's models and nothing else: separate config, working
 * directory, stores, identities, and — the part that had to be built for this —
 * separate secrets. A shared daemon makes it easy to accidentally couple two
 * agents, and the isolation is the property under test.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "multiharness-instances-"));
  delete process.env["MULTIHARNESS_HOME"];
});

afterEach(async () => {
  delete process.env["MULTIHARNESS_HOME"];
  await rm(root, { recursive: true, force: true });
});

async function instance(name: string, env?: string): Promise<string> {
  const home = path.join(root, name);
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.toml"), `[agent]\nname = "${name}"\n`, "utf8");
  if (env !== undefined) await writeFile(path.join(home, ".env"), env, "utf8");
  return home;
}

describe("discovering instances", () => {
  it("finds nothing in an empty root, rather than inventing one", async () => {
    expect(discoverInstances(root)).toEqual([]);
  });

  it("finds every directory holding a config, in a stable order", async () => {
    await instance("nephele");
    await instance("galatea");
    await mkdir(path.join(root, "notes"), { recursive: true }); // no config: not an instance

    expect(discoverInstances(root).map((ref) => ref.name)).toEqual(["galatea", "nephele"]);
  });

  it("treats a config in the root as a single unnamed instance", async () => {
    await writeFile(path.join(root, "config.toml"), `[agent]\nname = "solo"\n`, "utf8");
    await instance("ignored");

    expect(discoverInstances(root)).toEqual([{ name: path.basename(root), home: root }]);
  });

  it("narrows to exactly one when MULTIHARNESS_HOME says so", async () => {
    // It means "this agent". Pointing it at a directory and getting every
    // sibling as well would be a surprise, and it is how a single instance is
    // run from anywhere on disk.
    const home = await instance("galatea");
    await instance("nephele");
    process.env["MULTIHARNESS_HOME"] = home;

    expect(discoverInstances(root)).toEqual([{ name: "galatea", home }]);
  });
});

describe("selecting instances by name", () => {
  const all = [
    { name: "galatea", home: "/a" },
    { name: "nephele", home: "/b" },
    { name: "scout", home: "/c" },
  ];

  it("starts everything when nothing was asked for", () => {
    expect(selectInstances(all, [])).toEqual(all);
  });

  it("starts only what was named", () => {
    expect(selectInstances(all, ["scout"]).map((r) => r.name)).toEqual(["scout"]);
  });

  it("keeps discovery order, not argument order", () => {
    // So the startup log reads the same however the arguments were typed.
    expect(selectInstances(all, ["scout", "galatea"]).map((r) => r.name)).toEqual([
      "galatea",
      "scout",
    ]);
  });

  it("refuses a name it does not know, and says what does exist", () => {
    // A typo starting nothing — or worse, starting everything else — is the
    // shape of mistake that costs an afternoon.
    expect(() => selectInstances(all, ["galatae"])).toThrowError(/galatae/);
    expect(() => selectInstances(all, ["galatae"])).toThrowError(/galatea, nephele, scout/);
  });
});

describe("per-instance secrets", () => {
  it("keeps each instance's tokens to itself", async () => {
    // The concrete blocker to sharing a process: `process.loadEnvFile` is
    // global, so the second instance's .env used to overwrite the first's and
    // both would connect to Slack as whichever loaded last.
    const one = await instance("galatea", "SLACK_BOT_TOKEN=xoxb-one\n");
    const two = await instance("nephele", "SLACK_BOT_TOKEN=xoxb-two\n");

    const [a, b] = await Promise.all([readInstanceEnv(one), readInstanceEnv(two)]);

    expect(a["SLACK_BOT_TOKEN"]).toBe("xoxb-one");
    expect(b["SLACK_BOT_TOKEN"]).toBe("xoxb-two");
    expect(process.env["SLACK_BOT_TOKEN"]).toBeUndefined();
  });

  it("lets the file win over the environment", async () => {
    // This inverts what `--env-file` does, deliberately. With several instances
    // in one process, one exported token would otherwise be applied to all of
    // them and silently connect every agent as the same bot.
    process.env["SLACK_BOT_TOKEN"] = "xoxb-exported";
    try {
      const home = await instance("galatea", "SLACK_BOT_TOKEN=xoxb-file\n");
      expect((await readInstanceEnv(home))["SLACK_BOT_TOKEN"]).toBe("xoxb-file");
    } finally {
      delete process.env["SLACK_BOT_TOKEN"];
    }
  });

  it("falls back to the environment for anything the file does not set", async () => {
    process.env["MULTIHARNESS_TEST_ONLY"] = "inherited";
    try {
      const home = await instance("galatea", "SLACK_BOT_TOKEN=xoxb-file\n");
      expect((await readInstanceEnv(home))["MULTIHARNESS_TEST_ONLY"]).toBe("inherited");
    } finally {
      delete process.env["MULTIHARNESS_TEST_ONLY"];
    }
  });

  it("treats a missing .env as normal", async () => {
    // The console adapter needs no secrets at all.
    const home = await instance("scout");
    await expect(readInstanceEnv(home)).resolves.toBeTruthy();
  });

  it("reads the shapes an .env actually contains", () => {
    const parsed = parseEnv(
      [
        "# a comment",
        "",
        "SLACK_BOT_TOKEN=xoxb-plain",
        'export SLACK_APP_TOKEN="xapp-quoted"',
        "SINGLE='one'",
        "TRAILING=value # not part of it",
        "EMPTY=",
        "  SPACED = padded  ",
        "nonsense",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      SLACK_BOT_TOKEN: "xoxb-plain",
      SLACK_APP_TOKEN: "xapp-quoted",
      SINGLE: "one",
      TRAILING: "value",
      EMPTY: "",
      SPACED: "padded",
    });
  });

  it("keeps a # that is part of a token", async () => {
    // Only ` #` starts a comment, so a token containing a hash survives.
    expect(parseEnv("TOKEN=abc#def\n")["TOKEN"]).toBe("abc#def");
  });
});

describe("logging says which agent produced the line", () => {
  it("names the instance and its transport", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (message: string) => void lines.push(message);
    try {
      createLogger("galatea").scoped("slack").log("thinking");
      createLogger("nephele").log("session 000012 sealed");
    } finally {
      console.log = original;
    }

    expect(lines).toEqual(["galatea [slack]: thinking", "nephele: session 000012 sealed"]);
  });

  it("leaves the logger it was derived from alone", () => {
    // Immutable, so an instance can keep both the bare and the adapter-tagged
    // logger without one rewriting the other.
    const base = createLogger("galatea");
    const scoped = base.scoped("slack");
    expect(scoped).not.toBe(base);
  });
});
