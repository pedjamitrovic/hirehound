import type { JobDetail } from "../../shared/schemas/api.ts";
import { NO_CV, transitionOptions } from "../../shared/states.ts";
import type { AppContext } from "../app-context.ts";
import { HttpError, type Router } from "../http/router.ts";
import type { JobRecord } from "../workspace/job-files.ts";

export function toJobDetail(record: JobRecord): JobDetail {
  return {
    summary: record.summary,
    posting:
      record.posting || record.postingBody
        ? { frontmatter: record.posting, body: record.postingBody }
        : null,
    status: record.status,
    files: record.files,
    diagnostics: record.diagnostics,
    transitions: record.status ? transitionOptions(record.status, NO_CV) : [],
    hasRawHtml: record.hasRawHtml,
  };
}

export function requireJob(app: AppContext, id: string | undefined): JobRecord {
  const record = id ? app.index.get(id) : undefined;
  if (!record) throw new HttpError(404, "job-not-found", `No job with id ${id ?? ""}`);
  return record;
}

export function jobReadRoutes(router: Router, app: AppContext): void {
  router.get("/api/jobs", () => app.index.list());

  router.get("/api/jobs/:id", ({ params }) => toJobDetail(requireJob(app, params.id)));
}
