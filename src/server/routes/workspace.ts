import type { ServerEvent } from "../../shared/schemas/api.ts";
import type { AppContext } from "../app-context.ts";
import { HANDLED, type Router } from "../http/router.ts";
import { APP_VERSION } from "../version.ts";

export function workspaceRoutes(router: Router, app: AppContext): void {
  router.get("/api/health", () => ({ ok: true, version: APP_VERSION }));

  router.get("/api/workspace", () => app.index.info());

  router.get("/api/events", ({ req, res }) => {
    const hello: ServerEvent = { type: "hello", appVersion: APP_VERSION };
    app.hub.add(req, res, [hello]);
    return HANDLED;
  });
}
