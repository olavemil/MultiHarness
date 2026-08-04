import { lookup } from "node:dns/promises";
import net from "node:net";

/**
 * Guards the fetcher against reaching anything that is not the public web.
 *
 * This matters more here than in a typical client: the daemon runs beside
 * ollama on localhost, and on a laptop that shares a network with everything
 * else the operator can reach. A model that can be talked into fetching a URL —
 * and it can, since URLs arrive in chat messages — must not be able to reach
 * `127.0.0.1:11434`, a router admin page, or a cloud metadata endpoint.
 *
 * The check resolves DNS rather than pattern-matching the hostname, because a
 * public name can resolve to a private address.
 */

export interface UrlVerdict {
  ok: boolean;
  /** Why it was refused, phrased for the model to read. */
  reason?: string;
  url?: URL;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** IPv4 ranges that are never the public internet. */
function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts as [number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, which is also where cloud metadata services live.
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::1" || value === "::") return true;
  // Unique-local and link-local.
  if (/^f[cd]/.test(value) || value.startsWith("fe80")) return true;
  // IPv4-mapped addresses carry the IPv4 rules with them.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  return mapped ? isPrivateIpv4(mapped[1] as string) : false;
}

export const isPrivateAddress = (address: string): boolean =>
  net.isIPv4(address) ? isPrivateIpv4(address) : isPrivateIpv6(address);

export async function checkUrl(
  raw: string,
  allowedHosts: readonly string[] = [],
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid URL.` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Only http and https are allowed, not ${url.protocol}` };
  }

  if (allowedHosts.length > 0 && !hostAllowed(url.hostname, allowedHosts)) {
    return {
      ok: false,
      reason: `${url.hostname} is not in the configured allowlist (${allowedHosts.join(", ")}).`,
    };
  }

  // A literal private address, before any DNS is involved.
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    return { ok: false, reason: `${url.hostname} is a private address.` };
  }

  try {
    const resolved = await lookup(url.hostname, { all: true });
    if (resolved.some((entry) => isPrivateAddress(entry.address))) {
      return {
        ok: false,
        reason: `${url.hostname} resolves to a private address and will not be fetched.`,
      };
    }
  } catch {
    return { ok: false, reason: `${url.hostname} could not be resolved.` };
  }

  return { ok: true, url };
}

/** Matches a host or any subdomain of it. */
function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const allowedHost = entry.toLowerCase();
    return host === allowedHost || host.endsWith(`.${allowedHost}`);
  });
}
