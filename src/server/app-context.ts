import type { AiService } from "./ai/service.ts";
import type { SseHub } from "./http/sse.ts";
import type { JobService } from "./jobs/service.ts";
import type { Snapshot, SnapshotCache } from "./jobs/snapshot.ts";
import type { OnboardingService } from "./onboarding/service.ts";
import type { PdfRenderer } from "./pdf/render.ts";
import type { ProfileService } from "./profile/service.ts";
import type { TaskRunner } from "./tasks.ts";
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
  ai: AiService;
  tasks: TaskRunner;
  pdf: PdfRenderer;
  profile: ProfileService;
  onboarding: OnboardingService;
  log: (message: string) => void;
};
