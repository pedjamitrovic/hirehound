import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPath, strippedKeys } from "../validate.ts";
import { CreateJobRequest, PreviewRequest } from "./api.ts";
import {
  AnswersFile,
  Contact,
  EvaluationOutput,
  PostingFrontmatter,
  Preferences,
  StatusFile,
} from "./index.ts";

const AT = "2026-11-16T10:42:00+01:00";

describe("Preferences", () => {
  it("fills every section default from a minimal file", () => {
    const prefs = Preferences.parse({
      location: { based_in: { country: "RS" }, timezone: "Europe/Belgrade" },
    });
    assert.equal(prefs.version, 1);
    assert.equal(prefs.scoring.threshold, 70);
    assert.equal(prefs.cover_letter.policy, "when-requested");
    assert.equal(prefs.apply.mode, "manual");
    assert.equal(prefs.cv.max_pages, 2);
    assert.deepEqual(prefs.roles.exclude_title_keywords, []);
    assert.deepEqual(prefs.company.sizes, []);
    assert.equal(prefs.location.remote, "hybrid-ok");
  });

  it("rejects an invalid country and threshold", () => {
    const result = Preferences.safeParse({
      location: { based_in: { country: "Serbia" }, timezone: "Europe/Belgrade" },
      scoring: { threshold: 120 },
    });
    assert.equal(result.success, false);
    const paths = result.error?.issues.map((i) => formatPath(i.path)) ?? [];
    assert.deepEqual(paths.sort(), ["location.based_in.country", "scoring.threshold"]);
  });

  it("rejects an inverted salary range", () => {
    const result = Preferences.safeParse({
      location: { based_in: { country: "RS" }, timezone: "Europe/Belgrade" },
      compensation: { floor: { min: 100, max: 50, currency: "EUR" } },
    });
    assert.equal(result.success, false);
  });
});

describe("Contact", () => {
  it("validates email and link URLs", () => {
    assert.equal(Contact.safeParse({ name: "A", email: "nope" }).success, false);
    const ok = Contact.parse({
      name: "Alex Example",
      email: "alex@example.com",
      links: [{ label: "GitHub", url: "https://github.com/example" }],
    });
    assert.equal(ok.links.length, 1);
  });
});

describe("AnswersFile", () => {
  it("requires unique ids", () => {
    const answer = { id: "notice-period", question: "Notice period?", answer: "1 month" };
    assert.equal(AnswersFile.safeParse({ answers: [answer, answer] }).success, false);
    const parsed = AnswersFile.parse({ answers: [answer] });
    assert.equal(parsed.answers[0]?.kind, "text");
    assert.equal(parsed.answers[0]?.sensitive, false);
  });
});

describe("PostingFrontmatter", () => {
  it("accepts a fetched posting and defaults enums", () => {
    const parsed = PostingFrontmatter.parse({
      company: "Acme",
      title: "Engineering Manager",
      url: "https://boards.example.com/acme/jobs/1",
      source: "manual-url",
      fetched_at: AT,
      text_sha256: "0".repeat(64),
    });
    assert.equal(parsed.workplace, "unknown");
    assert.equal(parsed.employment_type, "unknown");
  });

  it("requires an offset on timestamps", () => {
    const result = PostingFrontmatter.safeParse({
      company: "Acme",
      title: "EM",
      source: "manual-text",
      fetched_at: "2026-11-16 10:42",
      text_sha256: "0".repeat(64),
    });
    assert.equal(result.success, false);
  });
});

describe("StatusFile", () => {
  it("requires at least one history event", () => {
    assert.equal(StatusFile.safeParse({ state: "found", history: [] }).success, false);
    const parsed = StatusFile.parse({
      state: "found",
      history: [{ at: AT, from: null, to: "found", by: "user" }],
    });
    assert.deepEqual(parsed.notes, []);
    assert.deepEqual(parsed.contacts, []);
  });

  it("knows the accepted state", () => {
    const parsed = StatusFile.parse({
      state: "accepted",
      history: [{ at: AT, from: "offer", to: "accepted", by: "user" }],
    });
    assert.equal(parsed.state, "accepted");
  });
});

describe("EvaluationOutput", () => {
  const valid = {
    summary: { text: "Platform EM", hidden_signals: [] },
    fit: {
      requirements: [
        {
          id: "R1",
          text: "People management",
          weight: "must",
          source: "jd-wording",
          match: "met",
          evidence: ["ACH-014"],
        },
      ],
      rationale: "Strong",
    },
    level: { base: "em", rationale: "EM title" },
    compensation: { basis: "unknown", range: null, note: "" },
    work_authorization: { status: "compatible", location_fit: "fits", note: "" },
    legitimacy: { live: "live", repost: "no", ghost_signals: [], risk: "low" },
    recommendation: { verdict: "apply", reason: "Good fit" },
  };

  it("accepts a valid output", () => {
    assert.equal(EvaluationOutput.safeParse(valid).success, true);
  });

  it("requires evidence exactly when matched", () => {
    const gapWithEvidence = structuredClone(valid);
    const first = gapWithEvidence.fit.requirements[0];
    if (first) first.match = "gap";
    assert.equal(EvaluationOutput.safeParse(gapWithEvidence).success, false);

    const metWithoutEvidence = structuredClone(valid);
    const req = metWithoutEvidence.fit.requirements[0];
    if (req) req.evidence = [];
    assert.equal(EvaluationOutput.safeParse(metWithoutEvidence).success, false);
  });

  it("rejects malformed bank ids", () => {
    const bad = structuredClone(valid);
    const req = bad.fit.requirements[0];
    if (req) req.evidence = ["ach-14"];
    assert.equal(EvaluationOutput.safeParse(bad).success, false);
  });
});

describe("API requests", () => {
  it("only accepts http(s) URLs for previews", () => {
    assert.equal(PreviewRequest.safeParse({ url: "https://example.com/jobs/1" }).success, true);
    assert.equal(PreviewRequest.safeParse({ url: "file:///etc/passwd" }).success, false);
    assert.equal(PreviewRequest.safeParse({ url: "not a url" }).success, false);
  });

  it("validates job creation by kind", () => {
    const text = CreateJobRequest.safeParse({
      kind: "text",
      company: " Acme ",
      title: "EM",
      text: "A long enough posting text for the test",
    });
    assert.equal(text.success, true);
    assert.equal(text.success && text.data.company, "Acme");
    assert.equal(
      CreateJobRequest.safeParse({ kind: "text", company: "", title: "EM", text: "x".repeat(30) })
        .success,
      false,
    );
    assert.equal(
      CreateJobRequest.safeParse({ kind: "url", company: "A", title: "B" }).success,
      false,
    );
  });
});

describe("strippedKeys", () => {
  it("finds unknown keys at any depth", () => {
    const input = {
      location: { based_in: { country: "RS" }, timezone: "Europe/Belgrade", tz: "x" },
      scoring: { treshold: 80 },
      extra: true,
    };
    const parsed = Preferences.parse(input);
    const found = strippedKeys(input, parsed).map(formatPath).sort();
    assert.deepEqual(found, ["extra", "location.tz", "scoring.treshold"]);
  });

  it("walks arrays", () => {
    const input = { answers: [{ id: "a", question: "Q", answer: "A", typo: 1 }] };
    const found = strippedKeys(input, AnswersFile.parse(input)).map(formatPath);
    assert.deepEqual(found, ["answers[0].typo"]);
  });
});
