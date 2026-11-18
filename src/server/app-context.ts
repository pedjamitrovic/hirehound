import type { SseHub } from "./http/sse.ts";
import type { WorkspaceIndex } from "./workspace/index.ts";

/** Everything route handlers need, created once per server. */
export type AppContext = {
  root: string;
  index: WorkspaceIndex;
  hub: SseHub;
  log: (message: string) => void;
};
