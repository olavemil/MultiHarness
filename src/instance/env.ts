import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Per-instance secrets, read into a scoped object and never into `process.env`.
 *
 * `process.loadEnvFile` was the concrete blocker to hosting several agents in
 * one process: it is global, so the second instance's `.env` would overwrite the
 * first's and both would connect to Slack as whichever loaded last. Nothing here
 * touches the environment.
 *
 * **The file wins over the environment**, which inverts what `--env-file` does.
 * With one process per agent, an exported `SLACK_BOT_TOKEN` overriding the file
 * was a convenient way to try a token. With several, that same export would be
 * applied to *every* instance and silently connect them all as one bot. The
 * file sits beside the instance and is unambiguously about that instance; the
 * environment can only fill in what the file does not say.
 */

export type Env = Readonly<Record<string, string>>;

/**
 * A deliberately small `.env` reader: `KEY=value`, `#` comments, optional
 * `export`, and matching quotes stripped. Escapes are honoured only inside
 * double quotes, as in a shell.
 *
 * Small because the only thing it ever reads is the two-line file `npm run init`
 * writes. A dependency for that would be a poor trade.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (key === "") continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // Unquoted values end at a trailing comment, as they do for `--env-file`.
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }

    out[key] = value;
  }

  return out;
}

/**
 * `<instance>/.env` layered over the process environment, for this instance
 * only. Absent is normal — the CLI adapter needs no secrets at all.
 */
export async function readInstanceEnv(home: string): Promise<Env> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }

  try {
    const text = await readFile(path.join(home, ".env"), "utf8");
    return Object.freeze({ ...inherited, ...parseEnv(text) });
  } catch {
    return Object.freeze(inherited);
  }
}
