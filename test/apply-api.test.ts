import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeEngine } from "../src/server/ai/fake.ts";
import type { AiRequest } from "../src/server/ai/types.ts";
import { ApplyBrowser } from "../src/server/apply/browser.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import { splitFrontmatter } from "../src/shared/frontmatter.ts";
import type { ApplicationView, AssistState, JobDetail } from "../src/shared/schemas/api.ts";
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
import { samplePosting, tempDir, tempWorkspace, writeJob } from "./helpers.ts";

/** A synthetic application form: the kind of fields a real ATS asks for, plus traps. */
const FORM = `<!doctype html>
<html><head><title>Apply: Engineering Manager at Acme</title></head><body>
<h1>Apply for Engineering Manager</h1>
<form id="apply" action="/submitted" method="post">
  <label for="first">First name</label><input id="first" name="first_name" required>
  <label for="last">Last name</label><input id="last" name="last_name" required>
  <label>Email <input type="email" name="email" required></label>
  <label for="phone">Phone</label><input id="phone" type="tel" name="phone">
  <label for="li">LinkedIn profile</label><input id="li" type="url" name="linkedin">
  <label for="resume">Resume/CV</label><input id="resume" type="file" name="resume" style="display:none">
  <label for="notice">What is your notice period?</label><input id="notice" name="notice">
  <fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
    <label><input type="radio" name="sponsor" value="yes"> Yes</label>
    <label><input type="radio" name="sponsor" value="no"> No</label>
  </fieldset>
  <label for="gender">Gender</label>
  <select id="gender" name="gender"><option value="">Select...</option><option>Female</option><option>Male</option><option>Decline to self-identify</option></select>
  <label for="why">Why do you want to work at Acme?</label><textarea id="why" name="why"></textarea>
  <label><input type="checkbox" id="consent" name="consent"> I agree to the privacy policy</label>
  <button type="submit">Submit application</button>
</form>
<iframe src="/frame" title="More questions"></iframe>
<script>document.getElementById("apply").addEventListener("submit", () => { window.submitted = true; });</script>
</body></html>`;

const FRAME = `<!doctype html><html><body><label for="city">Current city</label><input id="city" name="city"></body></html>`;

/** Fields as the map-form task renders them: "- id: X / type: T / label: "...". */
function fieldsIn(req: AiRequest<unknown>): { id: string; label: string }[] {
  return [...req.input.matchAll(/^- id: (\S+)\n\s+type: \S+[^\n]*\n\s+label: (".*")$/gm)].map(
    (m) => ({
      id: m[1] ?? "",
      label: JSON.parse(m[2] ?? '""') as string,
    }),
  );
}

/** A model that answers well, and also tries two things the code must refuse. */
function mapForm(req: AiRequest<unknown>) {
  const decide = (label: string) => {
    const fill = (value: string, source = "profile", answer_id: string | null = null) => ({
      action: "fill",
      value,
      source,
      answer_id,
      question: null,
      suggestion: null,
    });
    if (/first name/i.test(label)) return fill("Alex");
    if (/last name/i.test(label)) return fill("Example");
    if (/email/i.test(label)) return fill("alex@example.com");
    if (/phone/i.test(label)) return fill("+49 30 1234567");
    if (/linkedin/i.test(label)) return fill("https://www.linkedin.com/in/alex-example");
    if (/city/i.test(label)) return fill("Berlin");
    if (/notice/i.test(label)) return fill("One month", "library", "notice-period");
    if (/resume/i.test(label))
      return { ...fill(""), action: "upload-cv", value: null, source: null };
    if (/sponsorship/i.test(label)) return { ...fill("No"), action: "choose" };
    // Both of these must be turned into questions by the code, whatever the model says.
    if (/gender/i.test(label)) return { ...fill("Male"), action: "choose" };
    if (/privacy/i.test(label)) return { ...fill("true"), action: "check" };
    return {
      action: "ask",
      value: null,
      source: null,
      answer_id: null,
      question: "Why do you want to work at Acme?",
      suggestion: null,
    };
  };
  return { fields: fieldsIn(req).map((f) => ({ id: f.id, ...decide(f.label) })) };
}

describe("Apply: manual and assisted (M4)", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let config: Awaited<ReturnType<typeof tempDir>>;
  let profileDir: Awaited<ReturnType<typeof tempDir>>;
  let server: RunningServer;
  let site: Server;
  let siteUrl = "";
  let browserReady = false;
  const browser = { current: null as ApplyBrowser | null };
  const call = caller(() => server.url);
  const ASSISTED = "2026-11-16_acme_engineering-manager";
  const MANUAL = "2026-11-16_globex_platform-lead";

  before(async () => {
    ws = await tempWorkspace();
    config = await tempDir();
    profileDir = await tempDir("hirehound-browser-");
    await writeProfile(ws.root, {
      "profile/answers.yaml":
        "# My answers\nversion: 1\nanswers:\n  - id: notice-period\n    question: What is your notice period?\n    answer: One month\n",
    });
    await writeJob(ws.root, ASSISTED);
    await writeJob(ws.root, MANUAL, {
      posting: samplePosting({ company: "Globex", title: "Platform Lead" }),
    });

    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(req.url === "/frame" ? FRAME : FORM);
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/apply`;

    browser.current = new ApplyBrowser({ profileDir: profileDir.path, headless: true });
    try {
      await browser.current.open("probe", "about:blank");
      await browser.current.closeJob("probe");
      browserReady = true;
    } catch {
      browserReady = false;
    }

    server = await startServer({
      workspace: ws.root,
      configDir: config.path,
      port: 0,
      log: () => {},
      pdf: new FakePdfRenderer(),
      applyBrowser: browser.current,
      aiEngine: new FakeEngine({
        evaluate: () => evaluation(strongMatrix),
        tailor: () => ({ headline: "Engineering Manager", body: TAILORED, changes: [], notes: "" }),
        verify: supportAll,
        "map-form": mapForm,
      }),
    });
    for (const id of [ASSISTED, MANUAL]) {
      assert.equal((await runApiTask(call, "POST", `/api/jobs/${id}/evaluate`)).state, "done");
      assert.equal((await runApiTask(call, "POST", `/api/jobs/${id}/tailor`, {})).state, "done");
    }
  });

  after(async () => {
    await server.close();
    await new Promise((resolve) => site.close(resolve));
    await ws.cleanup();
    await config.cleanup();
    await profileDir.cleanup();
  });

  const view = async (id: string) =>
    (await call<ApplicationView>("GET", `/api/jobs/${id}/application`)).data;

  it("waits for an approved CV before applying", async () => {
    const before = await view(MANUAL);
    assert.equal(before.state, "ready");
    assert.match(before.blockers[0] ?? "", /applying starts once the CV is approved/);
    const refused = await call<{ error: { code: string } }>("POST", `/api/jobs/${MANUAL}/applied`, {
      method: "manual",
    });
    assert.equal(refused.status, 409);

    assert.equal((await call("POST", `/api/jobs/${MANUAL}/approve`, {})).status, 200);
    const ready = await view(MANUAL);
    assert.deepEqual(ready.blockers, []);
    assert.equal(ready.cv.approved, true);
    assert.equal(ready.cv.fileName, "Alex Example CV - Globex.pdf");
    assert.deepEqual(
      ready.contact.map((c) => c.label),
      ["Full name", "First name", "Last name", "Email", "Phone", "LinkedIn"],
    );
    assert.equal(ready.answers[0]?.id, "notice-period");
  });

  it("records a manual application with the approved PDF and the pasted confirmation", async () => {
    const res = await call<JobDetail>("POST", `/api/jobs/${MANUAL}/applied`, {
      method: "manual",
      confirmationText: "Thanks for applying to Globex!",
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.summary.state, "applied");
    const approval = res.data.status?.approval;
    assert.equal(res.data.status?.application?.method, "manual");
    assert.equal(res.data.status?.application?.cv_sha256, approval?.cv_sha256);

    const text = await readFile(join(ws.root, "jobs", MANUAL, "application.md"), "utf8");
    assert.match(text, /^---\nversion: 1\napplied_at: /);
    assert.match(text, /method: manual/);
    assert.match(splitFrontmatter(text).body, /> Thanks for applying to Globex!/);
    const pdf = await readFile(join(ws.root, "jobs", MANUAL, "cv.pdf"));
    assert.match(text, new RegExp(`sha256: ${sha256(pdf)}`));

    const download = await fetch(new URL(`/api/jobs/${MANUAL}/cv.pdf?download=1`, server.url));
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /attachment; filename="Alex Example CV - Globex.pdf"/,
    );
    await download.arrayBuffer();
  });

  it("fills a form in the browser, asks about sensitive questions and never submits", async (t) => {
    if (!browserReady) {
      t.skip("no Chrome or Edge here");
      return;
    }
    assert.equal((await call("POST", `/api/jobs/${ASSISTED}/approve`, {})).status, 200);
    const opened = await call<AssistState>("POST", `/api/jobs/${ASSISTED}/assist/open`, {
      url: siteUrl,
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.data));
    assert.equal(opened.data.title, "Apply: Engineering Manager at Acme");

    const task = await runApiTask(call, "POST", `/api/jobs/${ASSISTED}/assist/fill`);
    assert.equal(task.state, "done", task.error);
    const state = (await call<AssistState>("GET", `/api/jobs/${ASSISTED}/assist`)).data;
    const status = Object.fromEntries(state.fields.map((f) => [f.label, f.status]));
    assert.deepEqual(status, {
      "First name": "filled",
      "Last name": "filled",
      Email: "filled",
      Phone: "filled",
      "LinkedIn profile": "filled",
      "Resume/CV": "uploaded",
      "What is your notice period?": "filled",
      "Will you now or in the future require visa sponsorship?": "filled",
      Gender: "ask",
      "Why do you want to work at Acme?": "ask",
      "I agree to the privacy policy": "ask",
      "Current city": "filled",
    });
    // The model's guess for a sensitive question is not even passed on as a suggestion.
    assert.equal(state.fields.find((f) => f.label === "Gender")?.suggestion, undefined);

    const page = browser.current?.page(ASSISTED);
    assert.ok(page);
    const dom = await page.evaluate(`({
      first: document.querySelector("#first").value,
      notice: document.querySelector("#notice").value,
      sponsor: document.querySelector("input[name=sponsor]:checked")?.value ?? null,
      gender: document.querySelector("#gender").value,
      consent: document.querySelector("#consent").checked,
      resume: document.querySelector("#resume").files[0]?.name ?? null,
      city: document.querySelector("iframe").contentDocument.querySelector("#city").value,
      submitted: window.submitted === true,
    })`);
    assert.deepEqual(dom, {
      first: "Alex",
      notice: "One month",
      sponsor: "no",
      gender: "",
      consent: false,
      resume: "Alex Example CV - Acme.pdf",
      city: "Berlin",
      submitted: false,
    });

    const why = state.fields.find((f) => f.label.startsWith("Why"));
    const answered = await call<AssistState>("POST", `/api/jobs/${ASSISTED}/assist/answer`, {
      answers: [
        { fieldId: why?.id, value: "The platform team's work on developer tooling.", save: true },
      ],
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.data));
    assert.equal(answered.data.fields.find((f) => f.id === why?.id)?.status, "filled");
    assert.equal(
      await page.evaluate(`document.querySelector("#why").value`),
      "The platform team's work on developer tooling.",
    );
    const answers = await readFile(join(ws.root, "profile", "answers.yaml"), "utf8");
    assert.match(answers, /^# My answers\n/);
    assert.match(answers, /question: Why do you want to work at Acme\?/);
    assert.equal(await page.evaluate("window.submitted === true"), false);
  });

  it("records the assisted application with the answers used and a confirmation screenshot", async (t) => {
    if (!browserReady) {
      t.skip("no Chrome or Edge here");
      return;
    }
    const res = await call<JobDetail>("POST", `/api/jobs/${ASSISTED}/applied`, {
      method: "assisted",
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.summary.state, "applied");
    assert.equal(res.data.status?.application?.method, "assisted");
    const text = await readFile(join(ws.root, "jobs", ASSISTED, "application.md"), "utf8");
    assert.match(text, /method: assisted/);
    assert.match(text, /question: First name\n {4}answer: Alex\n {4}source: profile/);
    assert.match(text, /answer_id: notice-period/);
    assert.match(text, /answer: Alex Example CV - Acme.pdf\n {4}source: document/);
    assert.match(text, /screenshot: confirmation.png/);
    assert.ok((await stat(join(ws.root, "jobs", ASSISTED, "confirmation.png"))).size > 0);
  });
});
