import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeEngine } from "../src/server/ai/fake.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import type { CoverLetterView, JobDetail } from "../src/shared/schemas/api.ts";
import { FakePdfRenderer } from "./fake-pdf.ts";
import {
  caller,
  evaluation,
  runApiTask,
  sha256,
  strongMatrix,
  supportAll,
  TAILORED,
  writeProfile,
} from "./fixtures.ts";
import { tempDir, tempWorkspace, writeJob } from "./helpers.ts";

const LETTER = [
  "I would like to lead your team of 8 as Engineering Manager: at Acme Robotics I grew the platform group from 4 to 14 engineers in 18 months. <!-- ev: ROLE-001, ACH-001 -->",
  "",
  "Moving 30 services to Kubernetes taught me how to run a platform the way your posting describes. <!-- ev: ACH-003 -->",
  "",
  "I would welcome a conversation about the role. <!-- ev: ROLE-001 -->",
].join("\n");

describe("Cover letter (M4)", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let config: Awaited<ReturnType<typeof tempDir>>;
  let server: RunningServer;
  let letter = LETTER;
  const call = caller(() => server.url);
  const fake = new FakeEngine({
    evaluate: () => evaluation(strongMatrix),
    tailor: () => ({ headline: "Engineering Manager", body: TAILORED, changes: [], notes: "" }),
    verify: supportAll,
    "cover-letter": () => ({
      greeting: "Dear Acme hiring team,",
      body: letter,
      closing: "Kind regards,",
      notes: "Led with team growth.",
    }),
  });
  const JOB = "2026-11-16_acme_engineering-manager";

  before(async () => {
    ws = await tempWorkspace();
    config = await tempDir();
    await writeProfile(ws.root);
    await writeJob(ws.root, JOB, {
      body: "Lead a team of 8 engineers, grow the team and run Kubernetes.\n",
    });
    server = await startServer({
      workspace: ws.root,
      configDir: config.path,
      port: 0,
      log: () => {},
      pdf: new FakePdfRenderer(),
      aiEngine: fake,
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
    await config.cleanup();
  });

  const view = async () =>
    (await call<CoverLetterView>("GET", `/api/jobs/${JOB}/cover-letter`)).data;

  it("waits for an evaluation", async () => {
    const res = await call<{ error: { code: string } }>("POST", `/api/jobs/${JOB}/cover-letter`, {
      angle: "fit",
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, "not-evaluated");
  });

  it("writes a cited letter; figures about the job may come from the posting", async () => {
    assert.equal((await runApiTask(call, "POST", `/api/jobs/${JOB}/evaluate`)).state, "done");
    assert.equal((await runApiTask(call, "POST", `/api/jobs/${JOB}/tailor`, {})).state, "done");
    const task = await runApiTask(call, "POST", `/api/jobs/${JOB}/cover-letter`, {
      angle: "impact",
    });
    assert.equal(task.state, "done", task.error);
    assert.deepEqual(task.result, {
      checkErrors: 0,
      supported: 3,
      weakened: 0,
      unsupported: 0,
      pages: 1,
    });
    const prompt = fake.requests.filter((r) => r.task === "cover-letter").at(-1)?.input ?? "";
    assert.match(prompt, /## Angle: Impact first/);
    assert.match(
      prompt,
      /## The tailored CV \(the letter must agree with it\)\nEngineering manager who grows/,
    );
    const verify = fake.requests.filter((r) => r.task === "verify").at(-1)?.input ?? "";
    assert.match(verify, /## The job posting/);

    const text = await readFile(join(ws.root, "jobs", JOB, "cover-letter.md"), "utf8");
    assert.match(
      text,
      /^---\njob: 2026-11-16_acme_engineering-manager\nangle: impact\ngreeting: Dear Acme hiring team,/,
    );
    const v = await view();
    assert.equal(v.verification.state, "current");
    assert.equal(v.verification.supported, 3);
    assert.deepEqual(v.approve.blockers, []);
    assert.equal(v.policy, "when-requested");
    // The CV's state machine is not touched by the letter.
    assert.equal((await call<JobDetail>("GET", `/api/jobs/${JOB}`)).data.summary.state, "ready");
  });

  it("has its own approval, which an edit makes stale", async () => {
    const approved = await call<JobDetail>("POST", `/api/jobs/${JOB}/cover-letter/approve`);
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const pdf = await readFile(join(ws.root, "jobs", JOB, "cover-letter.pdf"));
    assert.equal(approved.data.status?.cover_letter_approval?.sha256, sha256(pdf));
    assert.equal((await view()).approval?.current, true);

    const before = await view();
    const edited = before.text.replace("a conversation", "a short conversation");
    const task = await runApiTask(call, "PUT", `/api/jobs/${JOB}/cover-letter`, {
      text: edited,
      expectedSha256: before.sha256,
    });
    assert.equal(task.state, "done", task.error);
    const after = await view();
    assert.equal(after.approval?.current, false);
    assert.equal(after.approve.allowed, true);
  });

  it("blocks headings, bullets and invented figures", async () => {
    const before = await view();
    const broken = `${before.text}\n## Why me\n\n- Grew a team of 25 <!-- ev: ACH-001 -->\n`;
    const task = await runApiTask(call, "PUT", `/api/jobs/${JOB}/cover-letter`, {
      text: broken,
      expectedSha256: before.sha256,
    });
    assert.equal(task.state, "done", task.error);
    const v = await view();
    assert.equal(v.approve.allowed, false);
    assert.match(v.approve.blockers.join(" "), /Checks failed: format, numbers/);
    const res = await call<{ error: { code: string } }>(
      "POST",
      `/api/jobs/${JOB}/cover-letter/approve`,
    );
    assert.equal(res.status, 409);

    // A different text than the one approved before, so its PDF is new as well.
    letter = LETTER.replace("a conversation", "a conversation soon");
    const fixed = await runApiTask(call, "POST", `/api/jobs/${JOB}/cover-letter`, {
      angle: "fit",
      feedback: "Remove the heading and the bullet",
    });
    assert.equal(fixed.state, "done", fixed.error);
    assert.match(
      fake.requests.filter((r) => r.task === "cover-letter").at(-1)?.input ?? "",
      /## Requested changes \(from the candidate\)\nRemove the heading and the bullet/,
    );
    assert.equal((await call("POST", `/api/jobs/${JOB}/cover-letter/approve`)).status, 200);
  });

  it("goes into the application record when it was sent", async () => {
    assert.equal((await call("POST", `/api/jobs/${JOB}/approve`, {})).status, 200);
    const res = await call<JobDetail>("POST", `/api/jobs/${JOB}/applied`, {
      method: "manual",
      coverLetter: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const pdf = await readFile(join(ws.root, "jobs", JOB, "cover-letter.pdf"));
    assert.equal(res.data.status?.application?.cover_letter_sha256, sha256(pdf));
    const record = await readFile(join(ws.root, "jobs", JOB, "application.md"), "utf8");
    assert.match(
      record,
      new RegExp(`cover_letter:\\n  file: cover-letter.pdf\\n  sha256: ${sha256(pdf)}`),
    );
    const locked = await call<{ error: { code: string } }>(
      "POST",
      `/api/jobs/${JOB}/cover-letter`,
      {
        angle: "fit",
      },
    );
    assert.equal(locked.data.error.code, "applied");
  });
});
