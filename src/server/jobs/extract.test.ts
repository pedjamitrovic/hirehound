import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { atsFromUrl, cleanTitle, descriptionToText, extractPosting } from "./extract.ts";

// Synthetic pages modelled on common ATS markup. Never commit real postings to this repo.

const greenhouseLike = `<!doctype html><html><head>
<title>Job Application for Engineering Manager, Platform at Acme Robotics</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "Engineering Manager, Platform",
  "hiringOrganization": { "@type": "Organization", "name": "Acme Robotics" },
  "jobLocation": [
    { "@type": "Place", "address": { "@type": "PostalAddress", "addressLocality": "Berlin", "addressCountry": "DE" } },
    { "@type": "Place", "address": { "addressLocality": "Amsterdam", "addressCountry": { "@type": "Country", "name": "NL" } } }
  ],
  "employmentType": "FULL_TIME",
  "datePosted": "2026-11-02T08:00:00Z",
  "validThrough": "2026-12-31",
  "baseSalary": { "@type": "MonetaryAmount", "currency": "eur",
    "value": { "@type": "QuantitativeValue", "minValue": 95000, "maxValue": 120000, "unitText": "YEAR" } },
  "description": "&lt;p&gt;Lead our platform team of 8.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Hybrid, 2 days in office&lt;/li&gt;&lt;/ul&gt;"
}
</script></head><body><main><h1>Engineering Manager, Platform</h1><p>Visible copy</p></main></body></html>`;

const graphLike = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"Careers"},
  {"@type":["JobPosting"],"title":"Staff Engineer","hiringOrganization":"Globex",
   "jobLocationType":"TELECOMMUTE","applicantLocationRequirements":[{"@type":"Country","name":"Germany"}],
   "employmentType":["CONTRACTOR"],"identifier":{"@type":"PropertyValue","value":"GX-77"},
   "description":"<p>Build things
   remotely.</p>"}
]}</script></head><body></body></html>`;

const ogOnly = `<html><head>
<meta property="og:site_name" content="Initech">
<meta property="og:title" content="Senior Backend Engineer | Initech">
<title>ignored</title></head><body><p>Remote friendly.</p></body></html>`;

describe("extractPosting", () => {
  it("reads a JSON-LD JobPosting with escaped HTML description", () => {
    const result = extractPosting(
      greenhouseLike,
      new URL("https://job-boards.greenhouse.io/acmerobotics/jobs/4012345"),
    );
    assert.equal(result.title, "Engineering Manager, Platform");
    assert.equal(result.company, "Acme Robotics");
    assert.equal(result.location, "Berlin, DE / Amsterdam, NL");
    assert.equal(result.employmentType, "full-time");
    assert.equal(result.workplace, "hybrid");
    assert.equal(result.postedAt, "2026-11-02");
    assert.equal(result.validThrough, "2026-12-31");
    assert.deepEqual(result.salary, {
      min: 95000,
      max: 120000,
      currency: "EUR",
      period: "year",
      raw: "EUR 95000-120000 per year",
    });
    assert.equal(result.sourceRef, "greenhouse:acmerobotics:4012345");
    assert.equal(
      descriptionToText(result.description ?? ""),
      "Lead our platform team of 8.\n\n- Hybrid, 2 days in office",
    );
  });

  it("finds postings inside @graph and tolerates raw newlines in strings", () => {
    const result = extractPosting(graphLike, new URL("https://careers.globex.example/jobs/77"));
    assert.equal(result.title, "Staff Engineer");
    assert.equal(result.company, "Globex");
    assert.equal(result.workplace, "remote");
    assert.equal(result.location, "Remote (Germany)");
    assert.equal(result.employmentType, "contract");
    assert.equal(result.sourceRef, null);
    assert.match(result.description ?? "", /Build things/);
  });

  it("falls back to OpenGraph and cleans the title", () => {
    const result = extractPosting(ogOnly, new URL("https://initech.example/careers/1"));
    assert.equal(result.company, "Initech");
    assert.equal(result.title, "Senior Backend Engineer");
    assert.equal(result.description, null);
  });

  it("uses the ATS board as a company fallback", () => {
    const html = "<html><head><title>Product Designer</title></head></html>";
    const result = extractPosting(html, new URL("https://jobs.lever.co/hooli-xyz/abc-123"));
    assert.equal(result.company, "Hooli Xyz");
    assert.equal(result.title, "Product Designer");
    assert.equal(result.sourceRef, "lever:hooli-xyz:abc-123");
  });

  it("ignores broken JSON-LD", () => {
    const html = `<script type="application/ld+json">{ not json</script><title>Role</title>`;
    assert.equal(extractPosting(html, new URL("https://x.example")).title, "Role");
  });

  it("returns nulls when nothing is known", () => {
    const result = extractPosting("<p>hello</p>", new URL("https://x.example"));
    assert.equal(result.title, null);
    assert.equal(result.company, null);
    assert.equal(result.workplace, "unknown");
  });
});

describe("atsFromUrl", () => {
  it("recognises the common public ATS URLs", () => {
    const cases: [string, string | null][] = [
      ["https://boards.greenhouse.io/acme/jobs/123", "greenhouse:acme:123"],
      ["https://boards.greenhouse.io/embed/job_app?for=acme&token=1", "greenhouse:acme:null"],
      ["https://jobs.ashbyhq.com/acme/0f1e2d", "ashby:acme:0f1e2d"],
      ["https://apply.workable.com/acme/j/AB12CD/", "workable:acme:AB12CD"],
      ["https://jobs.smartrecruiters.com/Acme/7431", "smartrecruiters:Acme:7431"],
      ["https://example.com/jobs/1", null],
    ];
    for (const [url, expected] of cases) {
      const ats = atsFromUrl(new URL(url));
      assert.equal(ats ? `${ats.provider}:${ats.board}:${ats.id}` : null, expected, url);
    }
  });
});

describe("cleanTitle", () => {
  it("strips common page-title decoration", () => {
    assert.equal(cleanTitle("Job Application for EM at Acme", "Acme"), "EM");
    assert.equal(cleanTitle("Acme - Staff Engineer", "Acme"), "Staff Engineer");
    assert.equal(cleanTitle("Staff Engineer | Acme", "Acme"), "Staff Engineer");
    assert.equal(cleanTitle("Staff Engineer | Careers", null), "Staff Engineer");
    assert.equal(cleanTitle("Acme", "Acme"), "Acme");
  });
});
