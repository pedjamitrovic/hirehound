import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeEngine } from "../src/server/ai/fake.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import { writeFileAtomic } from "../src/server/workspace/fsx.ts";
import { splitFrontmatter } from "../src/shared/frontmatter.ts";
import type { CvView, EvaluationView, JobDetail, TaskInfo } from "../src/shared/schemas/api.ts";
import type { VerificationFile } from "../src/shared/schemas/verification.ts";
import { FakePdfRenderer } from "./fake-pdf.ts";
import {
  BANK,
  BASE,
  claimsIn,
  evaluation,
  sha256,
  strongMatrix,
  TAILORED,
  weakMatrix,
} from "./fixtures.ts";
import { eventually, samplePosting, tempDir, tempWorkspace, writeJob } from "./helpers.ts";

describe("Evaluate, tailor, check and approve (M3)", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let config: Awaited<ReturnType<typeof tempDir>>;
  let server: RunningServer;
  let matrix: unknown[] = strongMatrix;
  let tailored: string = TAILORED;
  const verifyCalls: { n: number; text: string }[][] = [];
  const pdf = new FakePdfRenderer();
  const fake = new FakeEngine({
    evaluate: () => evaluation(matrix),
    tailor: () => ({
      headline: "Engineering Manager, Platform",
      body: tailored,
      changes: [{ what: "Led with Kubernetes", why: "The posting asks for it", ev: ["ACH-003"] }],
      notes: "Led with the Kubernetes migration.",
    }),
    verify: (req) => {
      const claims = claimsIn(req);
      verifyCalls.push(claims);
      return {
        claims: claims.map((c) =>
          c.text.includes("Rust")
            ? {
                n: c.n,
                verdict: "unsupported",
                reason: "Rust is not mentioned.",
                suggestion: "Built the billing service in Go",
              }
            : { n: c.n, verdict: "supported", reason: "Matches the entry.", suggestion: null },
        ),
      };
    },
  });
  const JOB = "2026-11-16_acme_engineering-manager";
  const LOW = "2026-11-16_initech_engineering-lead";

  before(async () => {
    ws = await tempWorkspace();
    config = await tempDir();
    const p = (rel: string) => join(ws.root, ...rel.split("/"));
    await writeFileAtomic(p("profile/experience-bank.yaml"), BANK);
    await writeFileAtomic(p("profile/bases/em.md"), BASE);
    await writeFileAtomic(
      p("profile/contact.yaml"),
      "version: 1\nname: Alex Example\nemail: alex@example.com\n",
    );
    await writeFileAtomic(
      p("profile/preferences.yaml"),
      "version: 1\nlocation:\n  based_in: { country: DE }\n  timezone: Europe/Berlin\nscoring:\n  threshold: 70\n",
    );
    await writeJob(ws.root, JOB, {
      body: "We need an engineering manager to grow the team and run Kubernetes.\n",
    });
    await writeJob(ws.root, LOW, {
      posting: samplePosting({ company: "Initech", title: "Engineering Lead" }),
      body: "Lead a team. Kubernetes required.\n",
    });
    server = await startServer({
      workspace: ws.root,
      configDir: config.path,
      port: 0,
      log: () => {},
      aiEngine: fake,
      pdf,
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
    await config.cleanup();
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

  const run = async (method: string, path: string, body?: unknown): Promise<TaskInfo> => {
    const started = await call<TaskInfo>(method, path, body);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    let task: TaskInfo | undefined;
    await eventually(async () => {
      task = (await call<TaskInfo>("GET", `/api/tasks/${started.data.id}`)).data;
      return task.state !== "running";
    }, 10_000);
    if (!task) throw new Error("task vanished");
    return task;
  };

  const job = async (id: string) => (await call<JobDetail>("GET", `/api/jobs/${id}`)).data;
  const cv = async (id: string) => (await call<CvView>("GET", `/api/jobs/${id}/cv`)).data;
  const file = (id: string, name: string) => readFile(join(ws.root, "jobs", id, name), "utf8");

  it("refuses to tailor before the job is evaluated", async () => {
    const res = await call<{ error: { code: string } }>("POST", `/api/jobs/${JOB}/tailor`, {});
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "not-evaluated");
  });

  it("evaluates a posting: matrix from the model, score from code", async () => {
    const task = await run("POST", `/api/jobs/${JOB}/evaluate`);
    assert.equal(task.state, "done", task.error);
    assert.equal(task.jobId, JOB);

    const detail = await job(JOB);
    assert.equal(detail.summary.state, "evaluated");
    assert.equal(detail.summary.score, 92);
    assert.equal(detail.summary.band, "strong");
    assert.equal(detail.summary.recommendation, "apply");
    assert.equal(detail.summary.base, "em");
    assert.equal(detail.status?.history.at(-1)?.by, "system");
    assert.equal(detail.usage.tasks, 1);

    const text = await file(JOB, "evaluation.md");
    assert.match(text, /^---\n/);
    assert.match(text, /score: 92/);
    assert.match(splitFrontmatter(text).body, /^# Evaluation: Engineering Manager at Acme/);

    const view = (await call<EvaluationView>("GET", `/api/jobs/${JOB}/evaluation`)).data;
    assert.equal(view.score?.score, 92);
    assert.deepEqual(view.stale, { posting: false, bank: false });
    assert.equal(view.evidence["ACH-003"]?.label, "Moved 30 services to Kubernetes");
    assert.deepEqual(view.bases, [{ id: "em", label: "Engineering Manager" }]);

    const prompt = fake.requests.at(-1);
    assert.match(prompt?.input ?? "", /ACH-003: Moved 30 services to Kubernetes/);
    assert.match(prompt?.input ?? "", /- em: Engineering Manager \(management\)/);
  });

  it("tailors, checks, verifies and renders: the job reaches Ready", async () => {
    const task = await run("POST", `/api/jobs/${JOB}/tailor`, {});
    assert.equal(task.state, "done", task.error);
    assert.deepEqual(task.result, {
      checkErrors: 0,
      supported: 6,
      weakened: 0,
      unsupported: 0,
      pages: 1,
    });

    const detail = await job(JOB);
    assert.equal(detail.summary.state, "ready");
    for (const name of ["cv.md", "cv.base.md", "changes.md", "verification.json", "cv.pdf"]) {
      assert.ok(detail.files.includes(name), name);
    }
    assert.equal(await file(JOB, "cv.base.md"), BASE);
    const cvText = await file(JOB, "cv.md");
    assert.match(cvText, /^---\njob: 2026-11-16_acme_engineering-manager\nbase: em\n/);
    assert.match(cvText, /theme: modern/);
    assert.match(await file(JOB, "changes.md"), /## Removed \(1\)\n\n- Introduced on-call/);

    const verification = JSON.parse(await file(JOB, "verification.json")) as VerificationFile;
    assert.equal(verification.cv_sha256, sha256(cvText));
    assert.equal(verification.claims.length, 6);
    const pdfBytes = await readFile(join(ws.root, "jobs", JOB, "cv.pdf"));
    assert.equal(verification.render?.pdf_sha256, sha256(pdfBytes));
    assert.equal(verification.render?.ats.coverage, 1);
    assert.equal(verifyCalls.at(-1)?.length, 6);

    const view = await cv(JOB);
    assert.equal(view.verification.state, "current");
    assert.equal(view.verification.supported, 6);
    assert.deepEqual(view.approve.blockers, []);
    assert.equal(view.approve.allowed, true);
    assert.equal(view.notes, "Led with the Kubernetes migration.");
    const diff = view.rows.map((r) =>
      r.t === "claim"
        ? `${r.claim.diff}:${r.claim.ev.join(",")}`
        : r.t === "removed"
          ? `removed:${r.ev.join(",")}`
          : `section:${r.text}`,
    );
    assert.deepEqual(diff, [
      "changed:ROLE-001,ACH-003",
      "section:Experience",
      "same:ROLE-001",
      "removed:ACH-002",
      "added:ACH-003",
      "changed:ACH-001",
      "same:ROLE-002",
      "same:ACH-004",
    ]);
  });

  it("re-verifies only the claim that changed, and an unsupported claim blocks Ready", async () => {
    const before = await cv(JOB);
    const edited = before.text.replace("in Go <!--", "in Go and Rust <!--");
    const task = await run("PUT", `/api/jobs/${JOB}/cv`, {
      text: edited,
      expectedSha256: before.sha256,
    });
    assert.equal(task.state, "done", task.error);
    assert.deepEqual(
      verifyCalls.at(-1)?.map((c) => c.text),
      ["Built the billing service in Go and Rust"],
    );

    assert.equal((await job(JOB)).summary.state, "tailoring");
    const view = await cv(JOB);
    assert.equal(view.verification.unsupported, 1);
    assert.equal(view.approve.allowed, false);
    assert.match(view.approve.blockers.join(" "), /1 claim is not supported/);
    const claim = view.rows.find((r) => r.t === "claim" && r.claim.text.includes("Rust"));
    assert.equal(
      claim?.t === "claim" ? claim.claim.suggestion : null,
      "Built the billing service in Go",
    );

    const refused = await call<{ error: { code: string } }>("POST", `/api/jobs/${JOB}/approve`, {});
    assert.equal(refused.status, 409);

    const stale = await call<{ error: { code: string } }>("PUT", `/api/jobs/${JOB}/cv`, {
      text: edited,
      expectedSha256: before.sha256,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, "changed-on-disk");

    const fixed = await run("PUT", `/api/jobs/${JOB}/cv`, {
      text: before.text,
      expectedSha256: view.sha256,
    });
    assert.equal(fixed.state, "done", fixed.error);
    assert.equal(verifyCalls.at(-1)?.length, 1);
    assert.equal((await job(JOB)).summary.state, "ready");
  });

  it("approves the exact PDF, and refuses to apply once the PDF changes", async () => {
    const approved = await call<JobDetail>("POST", `/api/jobs/${JOB}/approve`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.summary.state, "approved");
    const pdfPath = join(ws.root, "jobs", JOB, "cv.pdf");
    assert.equal(approved.data.status?.approval?.cv_sha256, sha256(await readFile(pdfPath)));
    assert.equal(approved.data.status?.approval?.base, "em");
    const apply = approved.data.transitions.find((t) => t.to === "applied" && t.kind === "edge");
    assert.equal(apply?.allowed, true);

    const edit = await call<{ error: { code: string } }>("PUT", `/api/jobs/${JOB}/cv`, {
      text: "x",
      expectedSha256: null,
    });
    assert.equal(edit.data.error.code, "approved");

    await appendFile(pdfPath, "%tampered\n");
    await server.context.index.reloadJob(JOB);
    const after = await job(JOB);
    const blocked = after.transitions.find((t) => t.to === "applied" && t.kind === "edge");
    assert.equal(blocked?.allowed, false);
    assert.match(blocked?.message ?? "", /changed after it was approved/);

    const revoked = await call<JobDetail>("POST", `/api/jobs/${JOB}/transitions`, { to: "ready" });
    assert.equal(revoked.data.summary.state, "ready");
    assert.equal(revoked.data.status?.approval, undefined);
  });

  it("keeps a tailored CV that fails the checks, and asks for a reason below the threshold", async () => {
    matrix = weakMatrix;
    const evaluated = await run("POST", `/api/jobs/${LOW}/evaluate`);
    assert.equal(evaluated.state, "done", evaluated.error);
    const low = await job(LOW);
    assert.equal(low.summary.score, 25);

    tailored = TAILORED.replace("4 to 14", "4 to 16");
    const failing = await run("POST", `/api/jobs/${LOW}/tailor`, {});
    assert.equal(failing.state, "done", failing.error);
    const repair = fake.requests.filter((r) => r.task === "tailor").at(-1);
    assert.match(repair?.input ?? "", /Your previous answer had these problems/);
    assert.match(repair?.input ?? "", /"16" does not appear in ACH-001/);
    assert.equal((await job(LOW)).summary.state, "tailoring");
    const view = await cv(LOW);
    assert.match(view.approve.blockers.join(" "), /Checks failed: numbers/);

    tailored = TAILORED;
    const fixed = await run("POST", `/api/jobs/${LOW}/tailor`, {
      feedback: "Use the real numbers",
    });
    assert.equal(fixed.state, "done", fixed.error);
    assert.match(
      fake.requests.filter((r) => r.task === "tailor").at(-1)?.input ?? "",
      /## Requested changes \(from the candidate\)\nUse the real numbers/,
    );
    assert.equal((await job(LOW)).summary.state, "ready");

    const needsReason = await call<{ error: { code: string } }>(
      "POST",
      `/api/jobs/${LOW}/approve`,
      {},
    );
    assert.equal(needsReason.status, 400);
    assert.equal(needsReason.data.error.code, "reason-required");
    const approved = await call<JobDetail>("POST", `/api/jobs/${LOW}/approve`, {
      overrideReason: "Referral from the hiring manager",
    });
    assert.equal(approved.status, 200);
    assert.equal(
      approved.data.status?.approval?.override_reason,
      "Referral from the hiring manager",
    );
  });
});
