import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Portal } from "../../shared/schemas/portals.ts";
import { Preferences } from "../../shared/schemas/preferences.ts";
import { BoardError, boardApiUrl, boardFromUrl, fetchBoard, parseBoard } from "./ats.ts";
import { containsTerm, filterReason, roleKey } from "./filter.ts";
import { emailParts, parseLinkedInAlert } from "./linkedin.ts";

const portal = (overrides: Partial<Portal> = {}) =>
  Portal.parse({
    id: "acme",
    company: "Acme Robotics",
    provider: "greenhouse",
    board: "acme",
    ...overrides,
  });

describe("ATS boards", () => {
  it("knows each provider's public API and recognises board links", () => {
    assert.equal(
      boardApiUrl(portal()),
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
    assert.equal(
      boardApiUrl(portal({ provider: "lever", region: "eu" })),
      "https://api.eu.lever.co/v0/postings/acme?mode=json",
    );
    assert.equal(
      boardApiUrl(portal({ provider: "ashby", board: "Acme" })),
      "https://api.ashbyhq.com/posting-api/job-board/Acme?includeCompensation=true",
    );
    assert.deepEqual(boardFromUrl("https://boards.greenhouse.io/acme/jobs/123"), {
      provider: "greenhouse",
      board: "acme",
      region: "global",
    });
    assert.deepEqual(boardFromUrl("https://jobs.eu.lever.co/globex"), {
      provider: "lever",
      board: "globex",
      region: "eu",
    });
    assert.equal(boardFromUrl("https://example.com/careers"), null);
  });

  it("reads Greenhouse jobs with entity-escaped HTML content", () => {
    const [job] = parseBoard(portal(), {
      jobs: [
        {
          id: 4012345,
          title: " Engineering Manager, Platform ",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/4012345",
          location: { name: "Berlin (Hybrid)" },
          first_published: "2026-11-10T09:00:00-05:00",
          updated_at: "2026-11-12T09:00:00-05:00",
          content:
            "&lt;h2&gt;About&lt;/h2&gt;&lt;p&gt;Lead a team of 8.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Kubernetes&lt;/li&gt;&lt;/ul&gt;",
        },
      ],
    });
    assert.deepEqual(job, {
      provider: "greenhouse",
      sourceRef: "greenhouse:acme:4012345",
      company: "Acme Robotics",
      title: "Engineering Manager, Platform",
      url: "https://boards.greenhouse.io/acme/jobs/4012345",
      location: "Berlin (Hybrid)",
      workplace: "hybrid",
      employmentType: "unknown",
      salary: null,
      postedAt: "2026-11-10",
      text: "## About\n\nLead a team of 8.\n\n- Kubernetes",
    });
  });

  it("reads Lever postings with lists, pay and workplace", () => {
    const [job] = parseBoard(portal({ provider: "lever" }), [
      {
        id: "abc-123",
        text: "Staff Engineer",
        hostedUrl: "https://jobs.lever.co/acme/abc-123",
        categories: { location: "Remote, EU", commitment: "Full-time" },
        createdAt: Date.parse("2026-11-01T00:00:00Z"),
        descriptionPlain: "Build the platform.",
        lists: [{ text: "What you will do", content: "<li>Own the CI</li><li>Mentor</li>" }],
        workplaceType: "remote",
        salaryRange: { min: 90000, max: 110000, currency: "eur", interval: "per-year-salary" },
      },
    ]);
    assert.equal(job?.sourceRef, "lever:acme:abc-123");
    assert.equal(job?.workplace, "remote");
    assert.equal(job?.employmentType, "full-time");
    assert.equal(job?.postedAt, "2026-11-01");
    assert.deepEqual(job?.salary, {
      min: 90000,
      max: 110000,
      currency: "EUR",
      period: "year",
      raw: "EUR 90000-110000 per year",
    });
    assert.equal(job?.text, "Build the platform.\n\n## What you will do\n\n- Own the CI\n- Mentor");
  });

  it("never guesses the period of a Lever pay range", () => {
    const pay = (salaryRange: Record<string, unknown>) => {
      const [job] = parseBoard(portal({ provider: "lever" }), [
        {
          id: "p1",
          text: "Engineer",
          hostedUrl: "https://jobs.lever.co/acme/p1",
          descriptionPlain: "Build things.",
          salaryRange,
        },
      ]);
      return { salary: job?.salary ?? null, text: job?.text };
    };
    assert.deepEqual(pay({ min: 40, max: 60, currency: "USD", interval: "per-hour-wage" }).salary, {
      min: 40,
      max: 60,
      currency: "USD",
      period: "hour",
      raw: "USD 40-60 per hour",
    });
    // Unknown or missing intervals stay text; they must not become a yearly salary.
    for (const interval of ["per-week-salary", "semi-month-salary", undefined]) {
      const result = pay({ min: 1500, max: 2000, currency: "USD", interval });
      assert.equal(result.salary, null, String(interval));
      assert.match(result.text ?? "", /Compensation: USD 1500-2000/);
    }
    assert.equal(
      pay({ max: 110000, currency: "EUR", interval: "per-year-salary" }).salary?.raw,
      "EUR up to 110000 per year",
    );
    // A range the wrong way round is put in order instead of producing an invalid posting.md.
    const swapped = pay({ min: 9, max: 5, currency: "EUR", interval: "per-hour-wage" }).salary;
    assert.deepEqual([swapped?.min, swapped?.max], [5, 9]);
  });

  it("reads Ashby jobs, skips unlisted ones and keeps the pay summary", () => {
    const jobs = parseBoard(portal({ provider: "ashby", board: "Acme" }), {
      jobs: [
        {
          title: "Engineering Manager",
          location: "Berlin",
          isListed: true,
          workplaceType: "Hybrid",
          employmentType: "FullTime",
          publishedAt: "2026-11-05T10:00:00.000+00:00",
          jobUrl: "https://jobs.ashbyhq.com/Acme/7f1c2d3e-0000-4000-8000-000000000001",
          descriptionPlain: "Lead the team.",
          compensation: { scrapeableCompensationSalarySummary: "EUR 90K - 110K" },
        },
        { title: "Hidden", isListed: false, jobUrl: "https://jobs.ashbyhq.com/Acme/x" },
      ],
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.sourceRef, "ashby:Acme:7f1c2d3e-0000-4000-8000-000000000001");
    assert.equal(jobs[0]?.workplace, "hybrid");
    assert.equal(jobs[0]?.employmentType, "full-time");
    assert.equal(jobs[0]?.text, "Lead the team.\n\nCompensation: EUR 90K - 110K");
  });

  it("explains boards that cannot be read", async () => {
    const answer = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      fetchBoard(portal(), { fetchImpl: answer(404, {}) }),
      (e: unknown) =>
        e instanceof BoardError && /no greenhouse board called "acme"/.test(e.message),
    );
    await assert.rejects(
      fetchBoard(portal(), { fetchImpl: answer(200, { nothing: true }) }),
      /unexpected format/,
    );
    const jobs = await fetchBoard(portal(), { fetchImpl: answer(200, { jobs: [] }) });
    assert.deepEqual(jobs, []);
  });
});

describe("filters", () => {
  const prefs = Preferences.parse({
    version: 1,
    roles: { exclude_title_keywords: ["intern"] },
    location: { based_in: { country: "DE" }, timezone: "Europe/Berlin", remote: "remote-only" },
    company: { exclude_companies: ["Initech"] },
  });
  const posting = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    company: "Acme Robotics",
    location: "Berlin",
    workplace: "remote" as const,
    ...extra,
  });

  it("matches whole words regardless of case and accents", () => {
    assert.equal(containsTerm("Sr. Engineering Manager", "engineering manager"), true);
    assert.equal(containsTerm("Internal Tools Lead", "intern"), false);
    assert.equal(containsTerm("D\u00e9veloppeur", "developpeur"), true);
    assert.equal(
      roleKey("Acme  Robotics", "Engineering-Manager"),
      "acme robotics|engineering manager",
    );
  });

  it("applies portal filters, then your preferences", () => {
    const p = portal({
      titles: ["engineering manager", "platform"],
      exclude_titles: ["sales"],
      locations: ["Berlin", "Remote"],
    });
    assert.equal(filterReason(posting("Engineering Manager"), p, prefs), null);
    assert.match(
      filterReason(posting("Account Executive"), p, prefs) ?? "",
      /none of this portal's words/,
    );
    assert.equal(
      filterReason(posting("Platform Sales Engineer"), p, prefs),
      'The title contains "sales"',
    );
    assert.equal(filterReason(posting("Platform Intern"), p, prefs), 'The title contains "intern"');
    assert.match(
      filterReason(
        posting("Platform Lead", { location: "Paris", workplace: "onsite" }),
        p,
        prefs,
      ) ?? "",
      /Paris is not one of/,
    );
    assert.equal(
      filterReason(posting("Platform Lead", { location: "Lisbon (Remote)" }), p, prefs),
      null,
    );
    assert.match(
      filterReason(posting("Platform Lead", { workplace: "hybrid" }), p, prefs) ?? "",
      /only want remote/,
    );
    assert.match(
      filterReason(posting("Platform Lead", { company: "initech" }), null, prefs) ?? "",
      /excluded in your preferences/,
    );
    // Unknown facts never filter.
    assert.equal(
      filterReason(posting("Platform Lead", { location: null, workplace: "unknown" }), p, prefs),
      null,
    );
  });
});

describe("LinkedIn job alerts", () => {
  const TEXT = [
    "Your job alert for engineering manager in Berlin",
    "30+ new jobs match your preferences.",
    "",
    "Engineering Manager, Platform",
    "Acme Robotics",
    "Berlin, Germany (Hybrid)",
    "Actively recruiting",
    "View job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc%3D%3D&refId=x",
    "",
    "---------------------------------------------------------",
    "",
    "Head of Developer Experience",
    "Globex",
    "Remote",
    "3 connections",
    "View job: https://www.linkedin.com/comm/jobs/view/4012345679/?trackingId=def",
    "",
    "See all jobs: https://www.linkedin.com/comm/jobs/search/?keywords=x",
  ].join("\n");

  it("reads job cards from the plain text", () => {
    assert.deepEqual(parseLinkedInAlert(TEXT), [
      {
        id: "4012345678",
        title: "Engineering Manager, Platform",
        company: "Acme Robotics",
        location: "Berlin, Germany (Hybrid)",
        url: "https://www.linkedin.com/jobs/view/4012345678/",
      },
      {
        id: "4012345679",
        title: "Head of Developer Experience",
        company: "Globex",
        location: "Remote",
        url: "https://www.linkedin.com/jobs/view/4012345679/",
      },
    ]);
  });

  it("reads a quoted-printable .eml and falls back to the HTML part", () => {
    const html =
      '<table><tr><td><a href=3D"https://www.linkedin.com/comm/jobs/view/4012345680/?x=3D1">Staff Eng=\nineer</a><p>Initech =C2=B7 Munich</p></td></tr></table>';
    const eml = [
      "From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>",
      "Subject: Staff Engineer at Initech",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      html,
      "--b1--",
    ].join("\r\n");
    assert.equal(emailParts(eml)[0]?.type, "text/html");
    assert.deepEqual(parseLinkedInAlert(eml), [
      {
        id: "4012345680",
        title: "Staff Engineer",
        company: "Initech",
        location: "Munich",
        url: "https://www.linkedin.com/jobs/view/4012345680/",
      },
    ]);
  });
});
