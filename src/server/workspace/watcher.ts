import { type FSWatcher, watch } from "node:fs";
import { isTempFile } from "./fsx.ts";
import { JOBS_DIR, MANIFEST_FILE } from "./layout.ts";

export type WatchTarget = { kind: "job"; id: string } | { kind: "profile" } | { kind: "rescan" };

/**
 * Maps a changed path (relative to the workspace, any separator) to what must be reloaded.
 * Returns null for paths the index does not care about.
 */
export function classifyChange(filename: string | null): WatchTarget | null {
  if (filename === null) return { kind: "rescan" };
  const parts = filename.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (parts.some((p) => p.startsWith(".")) || isTempFile(last)) return null;
  if (last.endsWith("~") || last.endsWith(".swp")) return null;
  const [top, second] = parts;
  if (top === JOBS_DIR) return second ? { kind: "job", id: second } : { kind: "rescan" };
  if (top === "profile" || top === MANIFEST_FILE) return { kind: "profile" };
  return null;
}

export type WatchHandlers = {
  job(id: string): Promise<unknown>;
  profile(): Promise<unknown>;
  rescan(): Promise<unknown>;
  /** Called once if native watching fails and the watcher falls back to polling. */
  onPolling?(reason: string): void;
  onError?(error: unknown): void;
};

export type WorkspaceWatcher = { readonly mode: "watching" | "polling"; close(): void };

export type WatchOptions = { debounceMs?: number; pollMs?: number; forcePolling?: boolean };

/**
 * Recursive fs.watch on the workspace, debounced per job folder. Editors, Claude Code and the
 * app itself all write here; reloads are idempotent so duplicate events are harmless. If native
 * watching is unavailable or fails (e.g. Linux inotify limits), it falls back to polling.
 */
export function watchWorkspace(
  root: string,
  handlers: WatchHandlers,
  options: WatchOptions = {},
): WorkspaceWatcher {
  const debounceMs = options.debounceMs ?? 120;
  const pollMs = options.pollMs ?? 2000;
  const timers = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | null = null;
  let poller: NodeJS.Timeout | null = null;
  let closed = false;
  let mode: "watching" | "polling" = "watching";

  const run = (task: () => Promise<unknown>) => {
    task().catch((error: unknown) => handlers.onError?.(error));
  };

  const schedule = (target: WatchTarget) => {
    const key = target.kind === "job" ? `job:${target.id}` : target.kind;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (closed) return;
        if (target.kind === "job") run(() => handlers.job(target.id));
        else if (target.kind === "profile") run(() => handlers.profile());
        else run(() => handlers.rescan());
      }, debounceMs),
    );
  };

  const startPolling = (reason: string) => {
    if (closed || poller) return;
    watcher?.close();
    watcher = null;
    mode = "polling";
    handlers.onPolling?.(reason);
    let busy = false;
    poller = setInterval(() => {
      if (busy) return;
      busy = true;
      Promise.all([handlers.rescan(), handlers.profile()])
        .catch((error: unknown) => handlers.onError?.(error))
        .finally(() => {
          busy = false;
        });
    }, pollMs);
    poller.unref();
  };

  if (options.forcePolling) {
    startPolling("polling requested");
  } else {
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        const target = classifyChange(filename === null ? null : String(filename));
        if (target) schedule(target);
      });
      watcher.on("error", (error) => startPolling(`file watching failed: ${String(error)}`));
    } catch (error) {
      startPolling(`file watching unavailable: ${String(error)}`);
    }
  }

  return {
    get mode() {
      return mode;
    },
    close() {
      closed = true;
      watcher?.close();
      if (poller) clearInterval(poller);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
