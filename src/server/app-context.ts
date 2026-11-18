import type { SseHub } from "./http/sse.ts";
import type { JobService } from "./jobs/service.ts";
import type { Snapshot, SnapshotCache } from "./jobs/snapshot.ts";
import type { WorkspaceIndex } from "./workspace/index.ts";

/** Everything route handlers need, created once per server. */
export type AppContext = {
  root: string;
  index: WorkspaceIndex;
  hub: SseHub;
  jobs: JobService;
  snapshots: SnapshotCache;
  /** Fetches and extracts a posting page (injectable so tests never touch the network). */
  fetchPosting: (url: string) => Promise<Snapshot>;
  /** Opens a folder in the OS file manager. */
  openFolder: (path: string) => void;
  log: (message: string) => void;
};
