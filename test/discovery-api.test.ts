import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { HttpError } from "../src/server/http/router.ts";
import type { Snapshot } from "../src/server/jobs/snapshot.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import type { JobDetail, JobSummary, SourcesView } from "../src/shared/schemas/api.ts";
import { caller, runApiTask, writeProfile } from "./fixtures.ts";
import { AT, samplePosting, sampleStatus, tempDir, tempWorkspace, writeJob } from "./helpers.ts";

type GreenhouseJob = { id: number; title: string; location: string };

const job = (id: number, title: string, location: string): GreenhouseJob => ({
  id,
  title,
  location,
});

/** The Greenhouse board as the fake network serves it; tests change it between scans. */
let acmeJobs: GreenhouseJob[] = [];
let acmeStatus = 200;

const boardFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/acme/jobs")) {
    const body = {
      jobs: acmeJobs.map((j) => ({
        id: j.id,
        title: j.title,
        absolute_url: `https://boards.greenhouse.io/acme/jobs/${j.id}`,
        location: { name: j.location },
        content: `&lt;p&gt;${j.title} at Acme Robotics. Lead the platform group.&lt;/p&gt;`,
      })),
    };
    return new Response(JSON.stringify(body), { status: acmeStatus });
  }
  if (url.startsWith("https://api.lever.co/v0/postings/globex")) {
    return Response.json([
      {
        id: "gx-1",
        text: "Head of Developer Experience",
        hostedUrl: "https://jobs.lever.co/globex/gx-1",
        categories: { location: "Remote", commitment: "Full-time" },
        descriptionPlain: "Own developer experience at Globex.",
        workplaceType: "remote",
      },
    ]);
  }
  return new Response("not found", { status: 404 });
};

const ALERT = [
  "Your job alert for engineering manager",
  "",
  "Engineering Manager, Payments",
  "Initech",
  "Munich, Germany",
  "View job: https://www.linkedin.com/comm/jobs/view/4000000001/?trackingId=a",
  "",
  "Platform Lead",
  "Umbrella",
  "Remote",
  "View job: https://www.linkedin.com/comm/jobs/view/4000000002/?trackingId=b",
].join("\n");

const fetchPosting = async (url: string): Promise<Snapshot> => {
  if (!url.includes("4000000001")) {
    throw new HttpError(422, "fetch-blocked", "LinkedIn refused the request.");
  }
  const text = `Initech is hiring an Engineering Manager for payments. ${"You will lead the team. ".repeat(12)}`;
  return {
    url,
    finalUrl: url,
    fetchedAt: AT,
    html: `<html><body>${text}</body></html>`,
    text,
    extracted: {
      title: null,
      company: null,
      location: null,
      workplace: "unknown",
      employmentType: "unknown",
      salary: null,
      postedAt: null,
      validThrough: null,
      description: null,
      sourceRef: null,
    },
    warnings: [],
  };
};

describe("Discovery (M5)", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let config: Awaited<ReturnType<typeof tempDir>>;
  let server: RunningServer;
  const call = caller(() => server.url);
  const OLD = "2026-10-01_acme-robotics_engineering-manager-platform";
  const LISTED = "2026-11-01_acme-robotics_site-reliability-engineer";

  before(async () => {
    ws = await tempWorkspace();
    config = await tempDir();
    await writeProfile(ws.root, {
      "profile/preferences.yaml":
        "version: 1\nroles:\n  exclude_title_keywords: [intern]\nlocation:\n  based_in: { country: DE }\n  timezone: Europe/Berlin\n",
    });
    // A role you skipped last month: posted again, it should be marked as a repost.
    await writeJob(ws.root, OLD, {
      posting: samplePosting({
        company: "Acme Robotics",
        title: "Engineering Manager, Platform",
        url: "https://boards.greenhouse.io/acme/jobs/1",
      }),
      status: sampleStatus({
        state: "skipped",
        history: [
          { at: AT, from: null, to: "found", by: "user" },
          { at: AT, from: "found", to: "skipped", by: "user", reason: "Too early" },
        ],
      }),
    });
    // Found earlier on the same board; it disappears in the first scan.
    await writeJob(ws.root, LISTED, {
      posting: samplePosting({
        company: "Acme Robotics",
        title: "Site Reliability Engineer",
        url: "https://boards.greenhouse.io/acme/jobs/999",
        source: "greenhouse",
        source_ref: "greenhouse:acme:999",
      }),
    });
    server = await startServer({
      workspace: ws.root,
      configDir: config.path,
      port: 0,
      log: () => {},
      schedule: false,
      boardFetch,
      fetchPosting,
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
    await config.cleanup();
  });

  const view = async () => (await call<SourcesView>("GET", "/api/sources")).data;
  const jobs = async () => (await call<JobSummary[]>("GET", "/api/jobs")).data;

  it("turns a board link into a portal and saves portals with a schedule", async () => {
    const draft = await call<{ provider: string; board: string; company: string }>(
      "POST",
      "/api/sources/board-from-url",
      { url: "https://boards.greenhouse.io/acme/jobs/4012345" },
    );
    assert.deepEqual(
      { provider: draft.data.provider, board: draft.data.board, company: draft.data.company },
      { provider: "greenhouse", board: "acme", company: "Acme" },
    );
    const bad = await call("POST", "/api/sources/board-from-url", {
      url: "https://example.com/jobs",
    });
    assert.equal(bad.status, 400);

    const empty = await view();
    assert.equal(empty.file.sha256, null);
    assert.equal(empty.nextScanAt, null);
    const saved = await call<SourcesView>("PUT", "/api/sources", {
      expectedSha256: null,
      value: {
        version: 1,
        schedule: { every_hours: 12 },
        portals: [
          {
            id: "acme",
            company: "Acme Robotics",
            provider: "greenhouse",
            board: "acme",
            titles: ["engineering", "platform"],
            locations: ["Berlin", "Remote"],
          },
          { id: "globex", company: "Globex", provider: "lever", board: "globex" },
        ],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.portals.length, 2);
    assert.ok(saved.data.nextScanAt, "never scanned: due now");
    const text = await readFile(join(ws.root, "sources", "portals.yaml"), "utf8");
    assert.match(text, /^# Job boards Hirehound scans for you/);

    const stale = await call<{ error: { code: string } }>("PUT", "/api/sources", {
      expectedSha256: null,
      value: { version: 1 },
    });
    assert.equal(stale.data.error.code, "changed-on-disk");
  });

  it("scans: adds new postings once, filters, marks reposts and expires vanished jobs", async () => {
    acmeJobs = [
      job(101, "Engineering Manager, Platform", "Berlin"),
      job(102, "Platform Intern", "Berlin"),
      job(103, "Account Executive", "Berlin"),
      job(104, "Staff Platform Engineer", "Remote"),
      job(105, "Platform Engineer", "Paris"),
    ];
    const task = await runApiTask(call, "POST", "/api/sources/scan", {});
    assert.equal(task.state, "done", task.error);
    assert.deepEqual(task.result, {
      sources: 2,
      failed: [],
      added: 3,
      filtered: 3,
      duplicates: 0,
      gone: 1,
      expired: 1,
    });

    const list = await jobs();
    const added = list.filter((j) => j.source === "greenhouse" || j.source === "lever");
    const repost = list.find((j) => j.title === "Engineering Manager, Platform" && j.id !== OLD);
    assert.equal(repost?.repostOf, OLD);
    assert.equal(repost?.state, "found");
    assert.equal(repost?.listed, true);
    assert.ok(
      added.some((j) => j.title === "Head of Developer Experience" && j.company === "Globex"),
    );

    const gone = (await call<JobDetail>("GET", `/api/jobs/${LISTED}`)).data;
    assert.equal(gone.summary.state, "expired");
    assert.equal(gone.summary.listed, false);
    const last = gone.status?.history.at(-1);
    assert.equal(last?.by, "system");
    assert.match(last?.reason ?? "", /No longer listed on the Acme Robotics job board/);

    const v = await view();
    const acme = v.portals.find((p) => p.id === "acme")?.lastScan;
    assert.deepEqual(
      acme?.filtered.map((f) => [f.title, f.reason]),
      [
        ["Platform Intern", 'The title contains "intern"'],
        ["Account Executive", "The title has none of this portal's words (engineering, platform)"],
        ["Platform Engineer", "Paris is not one of this portal's locations (Berlin, Remote)"],
      ],
    );
    assert.ok(v.nextScanAt && Date.parse(v.nextScanAt) > Date.now() + 11 * 3_600_000);
  });

  it("does not add a posting twice and notices when it is listed again", async () => {
    acmeJobs = [...acmeJobs, job(999, "Site Reliability Engineer", "Berlin")];
    const task = await runApiTask(call, "POST", "/api/sources/scan", { portals: ["acme"] });
    assert.deepEqual(task.result, {
      sources: 1,
      failed: [],
      added: 0,
      filtered: 3,
      duplicates: 3,
      gone: 0,
      expired: 0,
    });
    const back = (await call<JobDetail>("GET", `/api/jobs/${LISTED}`)).data;
    assert.equal(back.summary.listed, true);
    assert.equal(back.summary.state, "expired", "expiring is undone by you, not by a scan");
    assert.deepEqual(
      (await view()).scans[0]?.back.map((b) => b.id),
      [LISTED],
    );
  });

  it("changes nothing when a board is empty or broken", async () => {
    acmeJobs = [];
    const empty = await runApiTask(call, "POST", "/api/sources/scan", { portals: ["acme"] });
    assert.equal((empty.result as { gone: number }).gone, 0);
    acmeStatus = 404;
    const broken = await runApiTask(call, "POST", "/api/sources/scan", { portals: ["acme"] });
    assert.deepEqual((broken.result as { failed: unknown[] }).failed, [
      {
        source: "acme",
        error:
          'Acme Robotics: there is no greenhouse board called "acme". Check the board name in its URL.',
      },
    ]);
    assert.ok((await jobs()).every((j) => j.listed !== false || j.id === LISTED));
    acmeStatus = 200;
  });

  it("adds a filtered posting on request", async () => {
    acmeJobs = [job(103, "Account Executive", "Berlin")];
    const res = await call<JobDetail>("POST", "/api/sources/add", {
      source: "acme",
      ref: "greenhouse:acme:103",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.summary.title, "Account Executive");
    const again = await call<{ error: { code: string } }>("POST", "/api/sources/add", {
      source: "acme",
      ref: "greenhouse:acme:103",
    });
    assert.equal(again.data.error.code, "exists");
  });

  it("imports a LinkedIn alert, fetching each public page once", async () => {
    const task = await runApiTask(call, "POST", "/api/sources/linkedin", { text: ALERT });
    assert.equal(task.state, "done", task.error);
    assert.equal((task.result as { added: number }).added, 2);
    const list = await jobs();
    const initech = list.find((j) => j.company === "Initech");
    const umbrella = list.find((j) => j.company === "Umbrella");
    assert.equal(initech?.source, "linkedin-email");
    assert.equal(initech?.url, "https://www.linkedin.com/jobs/view/4000000001/");
    assert.equal(umbrella?.workplace, "remote");

    const withText = (await call<JobDetail>("GET", `/api/jobs/${initech?.id}`)).data;
    assert.match(withText.posting?.body ?? "", /Initech is hiring/);
    assert.ok(withText.files.includes("posting.html"));

    // LinkedIn refused the second page: the job waits for the posting text.
    const noText = await call<{ error: { code: string } }>(
      "POST",
      `/api/jobs/${umbrella?.id}/evaluate`,
    );
    assert.equal(noText.data.error.code, "no-posting-text");
    const pasted = await call<JobDetail>("PUT", `/api/jobs/${umbrella?.id}/posting`, {
      text: "Umbrella is hiring a platform lead to run the developer platform.",
    });
    assert.equal(pasted.status, 200);
    assert.match(pasted.data.posting?.body ?? "", /Umbrella is hiring/);

    const again = await runApiTask(call, "POST", "/api/sources/linkedin", { text: ALERT });
    assert.equal((again.result as { duplicates: number }).duplicates, 2);
    const log = await readFile(join(ws.root, "sources", "scans.jsonl"), "utf8");
    assert.match(
      log.trim().split("\n").at(-1) ?? "",
      /"source":"linkedin-email","trigger":"import"/,
    );
  });
});
