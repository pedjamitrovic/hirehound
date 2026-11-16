import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import type { AppContext } from "./app-context.ts";
import { checkRequest } from "./http/guard.ts";
import { HttpError, Router, sendError } from "./http/router.ts";
import { SseHub } from "./http/sse.ts";
import { serveStatic } from "./http/static.ts";
import { JobService } from "./jobs/service.ts";
import { fetchPosting, SnapshotCache } from "./jobs/snapshot.ts";
import { openExternal } from "./open.ts";
import { registerRoutes } from "./routes/index.ts";
import { errorCode } from "./workspace/fsx.ts";
import { WorkspaceIndex } from "./workspace/index.ts";
import { type WatchOptions, watchWorkspace } from "./workspace/watcher.ts";

export const DEFAULT_PORT = 4280;

export type ServerOptions = {
  workspace: string;
  /** 0 picks a free port (tests). */
  port?: number;
  /** Fail instead of trying the next ports when the port is taken. */
  strictPort?: boolean;
  /** Serve the UI through Vite middleware with live reload. */
  dev?: boolean;
  log?: (message: string) => void;
  watch?: WatchOptions;
  /** Test seams: no network, no file manager windows. */
  fetchPosting?: AppContext["fetchPosting"];
  openFolder?: AppContext["openFolder"];
};

export type RunningServer = {
  url: string;
  port: number;
  context: AppContext;
  close(): Promise<void>;
};

const DIST_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));
const VITE_CONFIG = fileURLToPath(new URL("../../vite.config.ts", import.meta.url));

async function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  strict: boolean,
): Promise<number> {
  const attempts = strict || port === 0 ? 1 : 20;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidate = port === 0 ? 0 : port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // Loopback only: the app serves personal data and must never be reachable from the network.
        server.listen(candidate, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      if (errorCode(error) !== "EADDRINUSE" || attempt === attempts - 1) throw error;
    }
  }
  throw new Error("unreachable");
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? ((message: string) => console.log(message));
  const index = new WorkspaceIndex(options.workspace);
  await index.load();
  const hub = new SseHub();
  index.subscribe((event) => hub.broadcast(event));
  const root = options.workspace;
  const context: AppContext = {
    root,
    index,
    hub,
    jobs: new JobService({ root, index }),
    snapshots: new SnapshotCache(),
    fetchPosting: options.fetchPosting ?? ((url) => fetchPosting(url)),
    openFolder: options.openFolder ?? openExternal,
    log,
  };

  const watcher = watchWorkspace(
    options.workspace,
    {
      job: (id) => index.reloadJob(id),
      profile: () => index.reloadProfile(),
      rescan: () => index.rescan(),
      onPolling: (reason) => {
        log(`Watching the workspace by polling (${reason}).`);
        index.setWatcherMode("polling");
      },
      onError: (error) => log(`Workspace reload failed: ${String(error)}`),
    },
    options.watch,
  );

  const router = new Router();
  registerRoutes(router, context);

  const server = createServer();
  let port = 0;
  let vite: ViteDevServer | undefined;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    const blocked = checkRequest(req.method ?? "GET", req.headers, port);
    if (blocked) {
      sendError(res, new HttpError(403, "forbidden", blocked));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      await router.handle(req, res, url);
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      });
      return;
    }
    await serveStatic(req, res, url, DIST_DIR);
  };

  server.on("request", (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendError(res, error);
        else res.end();
        return;
      }
      log(
        `Request failed: ${req.method} ${req.url}: ${error instanceof Error ? error.stack : String(error)}`,
      );
      if (!res.headersSent) sendError(res, new HttpError(500, "internal", "Something went wrong"));
      else res.destroy();
    });
  });

  if (options.dev) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      configFile: VITE_CONFIG,
      appType: "spa",
      server: { middlewareMode: true, hmr: { server } },
      logLevel: "warn",
    });
  }

  port = await listen(server, options.port ?? DEFAULT_PORT, options.strictPort ?? false);

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    context,
    async close() {
      watcher.close();
      hub.close();
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
