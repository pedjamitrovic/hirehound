import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ApproveBody,
  BulkTransitionBody,
  ContactBody,
  CoverLetterBody,
  CreateJobRequest,
  CvSaveBody,
  type DuplicateHint,
  type JobDetail,
  NoteBody,
  type PostingDraft,
  PreviewRequest,
  TailorBody,
  TransitionBody,
} from "../../shared/schemas/api.ts";
import type { AppContext } from "../app-context.ts";
import { HANDLED, HttpError, Reply, type Router } from "../http/router.ts";
import { textSha256 } from "../jobs/snapshot.ts";
import { isNotFound } from "../workspace/fsx.ts";
import type { JobRecord } from "../workspace/job-files.ts";
import { JOB_FILES, jobDir } from "../workspace/layout.ts";

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
    transitions: record.summary.transitions,
    hasRawHtml: record.hasRawHtml,
    usage: record.usage,
  };
}

export function requireJob(app: AppContext, id: string | undefined): JobRecord {
  const record = id ? app.index.get(id) : undefined;
  if (!record) throw new HttpError(404, "job-not-found", `No job with id ${id ?? ""}`);
  return record;
}

function duplicatesOf(app: AppContext, urls: string[], textHash: string): DuplicateHint[] {
  const wanted = new Set(urls.map((u) => u.replace(/[?#].*$/, "").replace(/\/$/, "")));
  const hits: DuplicateHint[] = [];
  for (const summary of app.index.list()) {
    const record = app.index.get(summary.id);
    const url = record?.posting?.url?.replace(/[?#].*$/, "").replace(/\/$/, "");
    if ((url && wanted.has(url)) || record?.posting?.text_sha256 === textHash) {
      hits.push({
        id: summary.id,
        company: summary.company,
        title: summary.title,
        state: summary.state,
      });
    }
  }
  return hits;
}

const IndexParam = z.coerce.number().int().min(0);

function indexParam(value: string | undefined): number {
  const parsed = IndexParam.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "invalid-index", "Invalid index");
  return parsed.data;
}

/** Raw third-party HTML: sandboxed, no scripts, no network, never in the app's origin. */
const RAW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export function jobRoutes(router: Router, app: AppContext): void {
  router.get("/api/jobs", () => app.index.list());

  router.get("/api/jobs/:id", ({ params }) => toJobDetail(requireJob(app, params.id)));

  router.post("/api/postings/preview", async ({ body }) => {
    const { url } = await body(PreviewRequest);
    const snapshot = await app.fetchPosting(url);
    const token = app.snapshots.put(snapshot);
    const e = snapshot.extracted;
    const draft: PostingDraft = {
      token,
      url: snapshot.url,
      finalUrl: snapshot.finalUrl,
      source: "manual-url",
      sourceRef: e.sourceRef,
      company: e.company,
      title: e.title,
      location: e.location,
      workplace: e.workplace,
      employmentType: e.employmentType,
      salary: e.salary,
      postedAt: e.postedAt,
      validThrough: e.validThrough,
      text: snapshot.text,
      warnings: snapshot.warnings,
      duplicates: duplicatesOf(app, [snapshot.url, snapshot.finalUrl], textSha256(snapshot.text)),
    };
    return draft;
  });

  router.post("/api/jobs", async ({ body }) => {
    const input = await body(CreateJobRequest);
    if (input.kind === "url") {
      const snapshot = app.snapshots.get(input.token);
      if (!snapshot) {
        throw new HttpError(
          410,
          "snapshot-expired",
          "The fetched page expired. Fetch the link again.",
        );
      }
      const record = await app.jobs.create(input, snapshot);
      app.snapshots.delete(input.token);
      return new Reply(201, toJobDetail(record));
    }
    return new Reply(201, toJobDetail(await app.jobs.create(input)));
  });

  router.post("/api/jobs/bulk-transition", async ({ body }) => {
    const { ids, ...req } = await body(BulkTransitionBody);
    return app.jobs.bulkTransition(ids, req);
  });

  router.post("/api/jobs/:id/transitions", async ({ params, body }) => {
    const req = await body(TransitionBody);
    const record = requireJob(app, params.id);
    return toJobDetail(await app.jobs.transition(record.id, req));
  });

  router.post("/api/jobs/:id/notes", async ({ params, body }) => {
    const { text } = await body(NoteBody);
    const record = requireJob(app, params.id);
    return toJobDetail(await app.jobs.addNote(record.id, text));
  });

  router.delete("/api/jobs/:id/notes/:index", async ({ params, url }) => {
    const record = requireJob(app, params.id);
    const at = url.searchParams.get("at") ?? "";
    return toJobDetail(await app.jobs.deleteNote(record.id, indexParam(params.index), at));
  });

  router.post("/api/jobs/:id/contacts", async ({ params, body }) => {
    const person = await body(ContactBody);
    const record = requireJob(app, params.id);
    return toJobDetail(await app.jobs.addContact(record.id, person));
  });

  router.delete("/api/jobs/:id/contacts/:index", async ({ params, url }) => {
    const record = requireJob(app, params.id);
    const name = url.searchParams.get("name") ?? "";
    return toJobDetail(await app.jobs.deleteContact(record.id, indexParam(params.index), name));
  });

  router.post("/api/jobs/:id/open-folder", ({ params }) => {
    const record = requireJob(app, params.id);
    app.openFolder(jobDir(app.root, record.id));
    return undefined;
  });

  // ---------- M3: evaluate, tailor, check, review, approve ----------

  router.post("/api/jobs/:id/evaluate", ({ params }) => {
    const record = requireJob(app, params.id);
    return new Reply(202, app.flow.startEvaluate(record.id));
  });

  router.get("/api/jobs/:id/evaluation", ({ params }) =>
    app.flow.evaluationView(requireJob(app, params.id).id),
  );

  router.post("/api/jobs/:id/tailor", async ({ params, body }) => {
    const input = await body(TailorBody);
    const record = requireJob(app, params.id);
    return new Reply(202, app.flow.startTailor(record.id, input));
  });

  router.get("/api/jobs/:id/cv", ({ params }) => app.flow.cvView(requireJob(app, params.id).id));

  router.put("/api/jobs/:id/cv", async ({ params, body }) => {
    const { text, expectedSha256 } = await body(CvSaveBody);
    const record = requireJob(app, params.id);
    return new Reply(202, await app.flow.saveCv(record.id, text, expectedSha256));
  });

  router.post("/api/jobs/:id/cv/check", ({ params }) => {
    const record = requireJob(app, params.id);
    return new Reply(202, app.flow.startCheck(record.id));
  });

  router.get("/api/jobs/:id/cv.pdf", async ({ params, url, res }) => {
    const record = requireJob(app, params.id);
    const pdf = await app.flow.cvPdf(record.id);
    // ?download=1 saves it under a name a recruiter can read: "Alex Example CV - Acme.pdf".
    const download = url.searchParams.get("download") === "1";
    const name = download
      ? app.apply.fileName(record, "CV", (await app.profile.contact()).value?.name ?? null)
      : `${record.id}.pdf`;
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": pdf.byteLength,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    });
    res.end(pdf);
    return HANDLED;
  });

  // ---------- M4: cover letter ----------

  router.post("/api/jobs/:id/cover-letter", async ({ params, body }) => {
    const input = await body(CoverLetterBody);
    const record = requireJob(app, params.id);
    return new Reply(202, app.flow.startCoverLetter(record.id, input));
  });

  router.get("/api/jobs/:id/cover-letter", ({ params }) =>
    app.flow.coverLetterView(requireJob(app, params.id).id),
  );

  router.put("/api/jobs/:id/cover-letter", async ({ params, body }) => {
    const { text, expectedSha256 } = await body(CvSaveBody);
    const record = requireJob(app, params.id);
    return new Reply(202, await app.flow.saveCoverLetter(record.id, text, expectedSha256));
  });

  router.post("/api/jobs/:id/cover-letter/check", ({ params }) => {
    const record = requireJob(app, params.id);
    return new Reply(202, app.flow.startCoverLetterCheck(record.id));
  });

  router.post("/api/jobs/:id/cover-letter/approve", async ({ params }) => {
    const record = requireJob(app, params.id);
    return toJobDetail(await app.flow.approveCoverLetter(record.id));
  });

  router.get("/api/jobs/:id/cover-letter.pdf", async ({ params, url, res }) => {
    const record = requireJob(app, params.id);
    const pdf = await app.flow.coverLetterPdf(record.id);
    const download = url.searchParams.get("download") === "1";
    const name = download
      ? app.apply.fileName(
          record,
          "Cover letter",
          (await app.profile.contact()).value?.name ?? null,
        )
      : `${record.id}-cover-letter.pdf`;
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": pdf.byteLength,
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
    });
    res.end(pdf);
    return HANDLED;
  });

  router.post("/api/jobs/:id/approve", async ({ params, body }) => {
    const { overrideReason } = await body(ApproveBody);
    const record = requireJob(app, params.id);
    return toJobDetail(await app.flow.approve(record.id, overrideReason));
  });

  router.get("/api/jobs/:id/raw/posting.html", async ({ params, res }) => {
    const record = requireJob(app, params.id);
    let html: Buffer;
    try {
      html = await readFile(join(jobDir(app.root, record.id), JOB_FILES.postingHtml));
    } catch (error) {
      if (isNotFound(error)) throw new HttpError(404, "not-found", "No raw snapshot for this job");
      throw error;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": RAW_CSP,
      "cache-control": "no-store",
      "content-length": html.byteLength,
    });
    res.end(html);
    return HANDLED;
  });
}
