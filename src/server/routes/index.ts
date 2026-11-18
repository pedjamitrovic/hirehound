import type { AppContext } from "../app-context.ts";
import type { Router } from "../http/router.ts";
import { jobRoutes } from "./jobs.ts";
import { workspaceRoutes } from "./workspace.ts";

export function registerRoutes(router: Router, app: AppContext): void {
  workspaceRoutes(router, app);
  jobRoutes(router, app);
}
