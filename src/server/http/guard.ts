import type { IncomingHttpHeaders } from "node:http";

/**
 * The server can read and write personal files, so it must only answer the local app:
 * - Host allowlist blocks DNS rebinding (a public site resolving its name to 127.0.0.1).
 * - Origin / Sec-Fetch-Site checks block cross-site requests from pages open in the browser.
 * Returns an error message, or null when the request is allowed.
 */
export function checkRequest(
  method: string,
  headers: IncomingHttpHeaders,
  port: number,
): string | null {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = headers.host?.toLowerCase();
  if (!host || !allowedHosts.has(host)) return "Invalid Host header";

  const origin = headers.origin;
  if (origin !== undefined && origin !== "null") {
    let originHost: string;
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "http:") return "Cross-origin request blocked";
      originHost = parsed.host.toLowerCase();
    } catch {
      return "Cross-origin request blocked";
    }
    if (!allowedHosts.has(originHost)) return "Cross-origin request blocked";
  } else if (origin === "null") {
    return "Cross-origin request blocked";
  }

  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const site = headers["sec-fetch-site"];
  if (!safe && site !== undefined && site !== "same-origin" && site !== "none") {
    return "Cross-site request blocked";
  }
  return null;
}
