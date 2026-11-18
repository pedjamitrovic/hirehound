import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AppliedBody, AssistAnswerBody, AssistOpenBody } from "../../shared/schemas/api.ts";
import type { AppContext } from "../app-context.ts";
import { HANDLED, HttpError, Reply, type Router } from "../http/router.ts";
import { isNotFound } from "../workspace/fsx.ts";
import { JOB_FILES, jobDir } from "../workspace/layout.ts";
import { requireJob, toJobDetail } from "./jobs.ts";

/** M4: the Application tab, assisted filling in the visible browser, and "I submitted". */
export function applyRoutes(router: Router, app: AppContext): void {
  router.get("/api/jobs/:id/application", ({ params }) =>
    app.apply.view(requireJob(app, params.id).id),
  );

  router.post("/api/jobs/:id/applied", async ({ params, body }) => {
    const input = await body(AppliedBody);
    const record = requireJob(app, params.id);
    return toJobDetail(await app.apply.submitted(record.id, input));
  });

  router.get("/api/jobs/:id/confirmation.png", async ({ params, res }) => {
    const record = requireJob(app, params.id);
    let png: Buffer;
    try {
      png = await readFile(join(jobDir(app.root, record.id), JOB_FILES.confirmation));
    } catch (error) {
      if (isNotFound(error)) throw new HttpError(404, "not-found", "No confirmation screenshot");
      throw error;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": png.byteLength,
      "cache-control": "no-store",
    });
    res.end(png);
    return HANDLED;
  });

  router.get("/api/jobs/:id/assist", ({ params }) =>
    app.apply.state(requireJob(app, params.id).id),
  );

  router.post("/api/jobs/:id/assist/open", async ({ params, body }) => {
    const { url } = await body(AssistOpenBody);
    const record = requireJob(app, params.id);
    return app.apply.open(record.id, url);
  });

  router.post("/api/jobs/:id/assist/fill", ({ params }) => {
    const record = requireJob(app, params.id);
    return new Reply(202, app.apply.startFill(record.id));
  });

  router.post("/api/jobs/:id/assist/answer", async ({ params, body }) => {
    const { answers } = await body(AssistAnswerBody);
    const record = requireJob(app, params.id);
    return app.apply.answer(record.id, answers);
  });

  router.post("/api/jobs/:id/assist/close", ({ params }) =>
    app.apply.close(requireJob(app, params.id).id),
  );
}
