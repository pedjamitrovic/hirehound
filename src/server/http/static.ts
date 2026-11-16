import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isNotFound } from "../workspace/fsx.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Production CSP for the app shell. Vite dev mode skips it (it needs inline HMR scripts). */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Hirehound</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>The web UI is not built yet</h1>
<p>Run <code>npm run build</code> and restart, or start the development server with <code>npm run dev</code>.</p>
</body>`;

async function fileAt(path: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size } : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Serves the built SPA from `distDir`, falling back to index.html for client-side routes. */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  distDir: string,
): Promise<void> {
  const root = resolve(distDir);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = "/";
  }
  const candidate = resolve(join(root, pathname));
  const insideRoot = candidate === root || candidate.startsWith(root + sep);

  let filePath = insideRoot ? candidate : null;
  let info = filePath ? await fileAt(filePath) : null;
  if (!info) {
    // SPA fallback: unknown paths without an extension render the app shell.
    if (extname(pathname) !== "") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    filePath = join(root, "index.html");
    info = await fileAt(filePath);
    if (!info) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(NOT_BUILT);
      return;
    }
  }
  if (!filePath) return;

  const type = TYPES[extname(filePath)] ?? "application/octet-stream";
  const immutable = filePath.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(type.startsWith("text/html") ? { "content-security-policy": APP_CSP } : {}),
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}
