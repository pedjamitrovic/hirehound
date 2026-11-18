import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fetchPosting } from "../src/server/jobs/snapshot.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import type {
  ApiErrorBody,
  BulkTransitionResult,
  JobDetail,
  PostingDraft,
} from "../src/shared/schemas/api.ts";
import { tempWorkspace } from "./helpers.ts";

const PAGE = `<html><head><title>Ignored</title>
<script type="application/ld+json">{"@type":"JobPosting","title":"Platform Engineering Manager",
"hiringOrganization":{"name":"Acme Robotics"},"jobLocationType":"TELECOMMUTE",
"employmentType":"FULL_TIME","description":"<p>${"Lead the platform team. ".repeat(20)}</p>"}</script>
</head><body><main><p>Visible</p></main></body></html>`;

const fakeFetch: typeof fetch = async () =>
  new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("Job API", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let server: RunningServer;
  const opened: string[] = [];

  before(async () => {
    ws = await tempWorkspace();
    server = await startServer({
      workspace: ws.root,
      port: 0,
      log: () => {},
      fetchPosting: (url) => fetchPosting(url, { fetchImpl: fakeFetch }),
      openFolder: (path) => opened.push(path),
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
  });

  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, server.url), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const data = res.status === 204 ? undefined : ((await res.json()) as T);
    return { status: res.status, data: data as T };
  };

  let jobId = "";

  it("previews a URL without writing anything, then creates the job", async () => {
    const preview = await call<PostingDraft>("POST", "/api/postings/preview", {
      url: "https://jobs.example.com/acme/1",
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.company, "Acme Robotics");
    assert.equal(preview.data.title, "Platform Engineering Manager");
    assert.equal(preview.data.workplace, "remote");
    assert.deepEqual(preview.data.duplicates, []);
    assert.match(preview.data.text, /^Lead the platform team/);
    assert.equal(server.context.index.list().length, 0);

    const created = await call<JobDetail>("POST", "/api/jobs", {
      kind: "url",
      token: preview.data.token,
      company: "Acme Robotics",
      title: "Platform Engineering Manager",
      workplace: "remote",
      employmentType: "full-time",
    });
    assert.equal(created.status, 201);
    jobId = created.data.summary.id;
    assert.equal(created.data.summary.state, "found");
    assert.equal(created.data.hasRawHtml, true);

    const again = await call<PostingDraft>("POST", "/api/postings/preview", {
      url: "https://jobs.example.com/acme/1?utm_source=x",
    });
    assert.deepEqual(
      again.data.duplicates.map((d) => d.id),
      [jobId],
    );
  });

  it("rejects an unknown or used snapshot token", async () => {
    const res = await call<ApiErrorBody>("POST", "/api/jobs", {
      kind: "url",
      token: "nope",
      company: "A",
      title: "B",
    });
    assert.equal(res.status, 410);
    assert.equal(res.data.error.code, "snapshot-expired");
  });

  it("creates a job from pasted text and validates input", async () => {
    const bad = await call<ApiErrorBody>("POST", "/api/jobs", {
      kind: "text",
      company: "",
      title: "EM",
      text: "short",
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.data.error.issues?.map((i) => i.path).sort(), ["company", "text"]);

    const ok = await call<JobDetail>("POST", "/api/jobs", {
      kind: "text",
      company: "Globex",
      title: "Staff Engineer",
      text: "A long enough posting text for a staff engineer role.",
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.posting?.frontmatter?.source, "manual-text");
  });

  it("moves jobs through states with clear errors", async () => {
    const moved = await call<JobDetail>("POST", `/api/jobs/${jobId}/transitions`, {
      to: "evaluated",
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.summary.state, "evaluated");
    assert.ok(moved.data.transitions.some((t) => t.to === "tailoring" && t.allowed));

    const invalid = await call<ApiErrorBody>("POST", `/api/jobs/${jobId}/transitions`, {
      to: "offer",
    });
    assert.equal(invalid.status, 409);
    const noReason = await call<ApiErrorBody>("POST", `/api/jobs/${jobId}/transitions`, {
      to: "skipped",
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.data.error.code, "reason-required");
  });

  it("moves several jobs at once", async () => {
    const ids = server.context.index.list().map((j) => j.id);
    const result = await call<BulkTransitionResult>("POST", "/api/jobs/bulk-transition", {
      ids,
      to: "skipped",
      reason: "Paused the search",
    });
    assert.equal(result.status, 200);
    assert.ok(result.data.results.every((r) => r.ok));
  });

  it("adds and removes notes", async () => {
    const added = await call<JobDetail>("POST", `/api/jobs/${jobId}/notes`, { text: "Call Ana" });
    const note = added.data.status?.notes[0];
    assert.equal(note?.text, "Call Ana");
    const removed = await call<JobDetail>(
      "DELETE",
      `/api/jobs/${jobId}/notes/0?at=${encodeURIComponent(note?.at ?? "")}`,
    );
    assert.equal(removed.data.status?.notes.length, 0);
  });

  it("serves the raw snapshot sandboxed", async () => {
    const res = await fetch(new URL(`/api/jobs/${jobId}/raw/posting.html`, server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /^sandbox; default-src 'none'/);
    assert.match(await res.text(), /JobPosting/);
  });

  it("opens the job folder through the OS seam", async () => {
    const res = await call<undefined>("POST", `/api/jobs/${jobId}/open-folder`, {});
    assert.equal(res.status, 204);
    assert.equal(opened.length, 1);
    assert.match(opened[0] ?? "", new RegExp(jobId));
  });

  it("requires JSON and same-origin for writes", async () => {
    const text = await fetch(new URL("/api/jobs", server.url), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(text.status, 415);
    const crossSite = await fetch(new URL("/api/jobs", server.url), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);
  });
});
