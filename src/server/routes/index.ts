import type { AppContext } from "../app-context.ts";
import type { Router } from "../http/router.ts";
import { jobRoutes } from "./jobs.ts";
import { onboardingRoutes } from "./onboarding.ts";
import { profileRoutes } from "./profile.ts";
import { workspaceRoutes } from "./workspace.ts";

export function registerRoutes(router: Router, app: AppContext): void {
  workspaceRoutes(router, app);
  jobRoutes(router, app);
  profileRoutes(router, app);
  onboardingRoutes(router, app);
}
