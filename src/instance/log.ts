/**
 * Every line says which agent produced it.
 *
 * With one process per agent the process itself was the label; with several in
 * one process, an unprefixed line is unattributable — and "which of them just
 * failed a session?" is exactly the question the log exists to answer. The
 * transport goes in the prefix too, because silence has opposite causes on
 * Slack and on the console.
 *
 *   galatea [slack]: thinking
 *   nephele: session 000012 absorbed 1 message(s)
 */
export interface Logger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** A copy of this logger tagged with a transport. Immutable, so it is safe to keep both. */
  scoped(scope: string): Logger;
}

export function createLogger(name: string, scope?: string): Logger {
  const prefix = scope ? `${name} [${scope}]:` : `${name}:`;

  return {
    log: (message) => console.log(`${prefix} ${message}`),
    warn: (message) => console.warn(`${prefix} ${message}`),
    error: (message) => console.error(`${prefix} ${message}`),
    scoped: (next) => createLogger(name, next),
  };
}
