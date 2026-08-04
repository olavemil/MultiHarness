#!/usr/bin/env node
/**
 * Creates an agent instance under ~/.multiharness/<bot-name>.
 *
 *   npm run init                                   # prompts for tokens
 *   SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… npm run init
 *   npm run init -- --bot-token xoxb-… --app-token xapp-…
 *   npm run init -- --no-slack --name scout        # local-only instance
 *
 * The bot's name comes from Slack rather than from an answer here: it is the
 * authoritative one, and the harness resolves the bot's own user id to it so
 * that mention detection works. Getting it wrong makes the agent silently
 * ignore everyone who addresses it.
 *
 * Tokens are verified before anything is written, and land in .env with mode
 * 600 — never in config.toml, which is the file people share and diff.
 *
 * Prefer the environment or the prompt over flags: arguments are visible to
 * anything that can list processes.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.join(homedir(), ".multiharness");
const argv = process.argv.slice(2);

const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const present = (name) => argv.includes(`--${name}`);

const rl = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

async function ask(question, fallback = "") {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer === "" ? fallback : answer;
}

/** Calls Slack and returns the identity behind a bot token. */
async function verifyBotToken(token) {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`bot token rejected by Slack: ${body.error}`);
  return { name: body.user, userId: body.user_id, team: body.team };
}

/**
 * Socket Mode needs an app-level token with `connections:write`. Opening a
 * connection URL is the only way to know it actually works; the URL is simply
 * discarded.
 */
async function verifyAppToken(token) {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json();
  if (!body.ok) throw new Error(`app token rejected by Slack: ${body.error}`);
}

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";

function renderConfig({ name, aliases, slack, threadMode }) {
  const quote = (v) => JSON.stringify(v);
  return `# ${name} — instance configuration.
#
# Layered over config/default.toml in the repo, which holds the conventions and
# the measured defaults. Only what makes this instance different belongs here.
#
# No secrets: Slack tokens live in .env beside this file.

[agent]
name = ${quote(name)}
aliases = [${aliases.map(quote).join(", ")}]

[slack]
enabled = ${slack}
thread_mode = ${quote(threadMode)}

# Personality and preferences will hang off this file as they land — tone,
# verbosity, which steps this instance may run.
`;
}

async function main() {
  const useSlack = !present("no-slack");
  let name = flag("name");
  let aliases = [];
  let botToken;
  let appToken;
  const threadMode = flag("thread-mode") ?? "separate";

  if (useSlack) {
    botToken = flag("bot-token") ?? process.env.SLACK_BOT_TOKEN ?? (await ask("Slack bot token (xoxb-…)"));
    appToken = flag("app-token") ?? process.env.SLACK_APP_TOKEN ?? (await ask("Slack app token (xapp-…)"));

    if (!botToken || !appToken) {
      throw new Error(
        "Both tokens are required. Pass --bot-token/--app-token, set SLACK_BOT_TOKEN and " +
          "SLACK_APP_TOKEN, or run this in a terminal to be prompted. Use --no-slack for a " +
          "local-only instance.",
      );
    }

    process.stdout.write("Verifying tokens with Slack… ");
    const identity = await verifyBotToken(botToken);
    await verifyAppToken(appToken);
    console.log(`ok — ${identity.name} in ${identity.team}`);

    name ??= identity.name;
    // The @ form is what people actually type; the raw id is what Slack sends
    // before the adapter rewrites it.
    aliases = [`@${name}`, identity.userId];
  }

  name ??= await ask("Agent name", "harness");
  if (aliases.length === 0) aliases = [`@${name}`];

  const home = path.join(ROOT, slugify(name));
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "config.toml"),
    renderConfig({ name, aliases, slack: useSlack, threadMode }),
    "utf8",
  );

  if (useSlack) {
    const envPath = path.join(home, ".env");
    await writeFile(envPath, `SLACK_BOT_TOKEN=${botToken}\nSLACK_APP_TOKEN=${appToken}\n`, "utf8");
    await chmod(envPath, 0o600);
  }

  const siblings = await countInstances();
  console.log(`\nInstance ready: ${home}`);
  console.log(`  config.toml   identity and settings`);
  if (useSlack) console.log(`  .env          tokens, mode 600`);
  console.log(
    siblings > 1
      ? `\nStart it with:\n  MULTIHARNESS_HOME=${home} npm run dev`
      : `\nStart it with:\n  npm run dev`,
  );
}

/** More than one instance means the daemon can no longer pick by itself. */
async function countInstances() {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(ROOT, { withFileTypes: true });
    let found = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(path.join(ROOT, entry.name, "config.toml"), "utf8");
        found++;
      } catch {
        // Not an instance directory.
      }
    }
    return found;
  } catch {
    return 0;
  }
}

try {
  await main();
} catch (cause) {
  console.error(`\n${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
