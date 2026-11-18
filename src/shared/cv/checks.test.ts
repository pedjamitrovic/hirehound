import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BankFile } from "../schemas/bank.ts";
import { checkTailoredCv, datesIn, numbersIn } from "./checks.ts";
import { cvClaims } from "./claims.ts";
import { parseCv } from "./parse.ts";

const bank = BankFile.parse({
  version: 1,
  roles: [
    {
      id: "ROLE-001",
      company: "Acme Robotics",
      title: "Engineering Manager",
      start: "2021-03",
      end: "present",
      confirmed: true,
      achievements: [
        {
          id: "ACH-001",
          text: "Grew the platform group from 4 to 14 engineers in 18 months",
          metrics: ["4 to 14 engineers", "18 months"],
          confirmed: true,
        },
        {
          id: "ACH-002",
          text: "Cut p95 latency by 40% for 1,200 services",
          confirmed: true,
        },
        { id: "ACH-003", text: "Ran the on-call rotation", confirmed: false },
      ],
    },
    {
      id: "ROLE-002",
      company: "Globex",
      title: "Senior Software Engineer",
      start: "2017",
      end: "2021",
      confirmed: true,
      achievements: [
        {
          id: "ACH-004",
          text: "Built the B2B billing service with two other engineers",
          confirmed: true,
        },
      ],
    },
  ],
  education: [
    { id: "EDU-001", institution: "University of Belgrade", degree: "BSc", confirmed: true },
  ],
});

function check(text: string) {
  return checkTailoredCv(parseCv(text).doc, bank);
}

function messages(text: string): string[] {
  return check(text).issues.map((i) => `${i.check}: ${i.message}`);
}

describe("numbersIn", () => {
  it("reads figures as written and normalises separators", () => {
    assert.deepEqual(
      numbersIn("40% of 1,200 services in 18 months, 3,5x, p95").map((t) => t.value),
      ["40", "1200", "18", "3.5", "95"],
    );
  });

  it("skips names with digits inside and reads number words", () => {
    assert.deepEqual(
      numbersIn("B2B on K8s with two teams").map((t) => t.value),
      ["2"],
    );
  });
});

describe("datesIn", () => {
  it("finds every common date form and blanks them out", () => {
    const { dates, rest } = datesIn("Lead | 2021-03 - present, Mar 2019, 03/2018, 2015 - 2017");
    assert.deepEqual(
      dates.map((d) => ("present" in d ? "present" : `${d.year}-${d.month ?? ""}`)),
      ["2021-03", "2018-03", "2019-03", "2015-", "2017-", "present"],
    );
    assert.doesNotMatch(rest, /\d/);
  });
});

describe("checkTailoredCv", () => {
  it("passes a CV that matches the bank", () => {
    const result = check(
      [
        "## Experience",
        "",
        "### Engineering Manager, Acme Robotics | 2021-03 - present <!-- ev: ROLE-001 -->",
        "",
        "- Grew the platform group from four to 14 engineers in 18 months <!-- ev: ACH-001 -->",
        "- Cut p95 latency by 40% across 1200 services <!-- ev: ACH-002 -->",
        "",
        "### Senior Software Engineer, Globex | 2017 - 2021 <!-- ev: ROLE-002 -->",
        "",
        "- Built a B2B billing service in a team of three, at Globex <!-- ev: ACH-004 -->",
        "",
        "## Education",
        "",
        "### BSc, University of Belgrade <!-- ev: EDU-001 -->",
      ].join("\n"),
    );
    assert.deepEqual(result.issues, [
      {
        check: "numbers",
        n: 4,
        line: 10,
        severity: "error",
        message: '"three" does not appear in ACH-004',
      },
    ]);
    assert.equal(result.errors.numbers, 1);
    assert.equal(result.errors.dates, 0);
  });

  it("requires a marker, known ids and confirmed entries", () => {
    assert.deepEqual(
      messages("- Ran on-call\n- Ran on-call <!-- ev: ACH-003 -->\n- X <!-- ev: ACH-999 -->"),
      [
        "evidence: No evidence marker: every claim cites the experience bank",
        "evidence: ACH-003 is not confirmed in the experience bank yet",
        "evidence: ACH-999 is not in the experience bank",
      ],
    );
  });

  it("rejects invented numbers", () => {
    assert.deepEqual(messages("- Grew the group from 4 to 16 engineers <!-- ev: ACH-001 -->"), [
      'numbers: "16" does not appear in ACH-001',
    ]);
  });

  it("allows the dates of the parent role in an achievement", () => {
    assert.deepEqual(messages("- Since 2021, grew the group to 14 <!-- ev: ACH-001 -->"), []);
  });

  it("rejects a changed title or company in an entry heading", () => {
    assert.deepEqual(
      messages("### Senior Engineering Manager, Acme | 2021-03 - present <!-- ev: ROLE-001 -->"),
      [
        'titles: The job title must be "Engineering Manager" as in ROLE-001',
        'companies: The company must be written "Acme Robotics" as in ROLE-001',
      ],
    );
  });

  it("accepts common heading layouts", () => {
    for (const heading of [
      "### Engineering Manager at Acme Robotics (2021-03 - present) <!-- ev: ROLE-001 -->",
      "### Acme Robotics \u00b7 Engineering Manager \u00b7 2021-03 \u2013 present <!-- ev: ROLE-001 -->",
      "### engineering manager | acme robotics <!-- ev: ROLE-001 -->",
    ]) {
      assert.deepEqual(messages(heading), [], heading);
    }
  });

  it("rejects dates the bank does not have", () => {
    assert.deepEqual(
      messages("### Engineering Manager, Acme Robotics | Jan 2021 - present <!-- ev: ROLE-001 -->"),
      ['dates: "Jan 2021" is not a start or end date of the cited entries'],
    );
    assert.deepEqual(
      messages("### Senior Software Engineer, Globex | 2016-05 - 2021 <!-- ev: ROLE-002 -->"),
      ['dates: "2016-05" is not a start or end date of the cited entries'],
    );
    assert.deepEqual(
      messages("### Senior Software Engineer, Globex | 2017-05 - present <!-- ev: ROLE-002 -->"),
      [
        'dates: "2017-05": the experience bank only has the year, not the month',
        'dates: "present": none of the cited entries ends at present',
      ],
    );
  });

  it("rejects a company the cited entries are not about", () => {
    assert.deepEqual(messages("- Grew the Globex group to 14 engineers <!-- ev: ACH-001 -->"), [
      "companies: Mentions Globex, but no cited entry is about Globex",
    ]);
  });

  it("checks institutions in education headings", () => {
    assert.deepEqual(messages("### BSc, Belgrade University <!-- ev: EDU-001 -->"), [
      'companies: The institution must be written "University of Belgrade" as in EDU-001',
    ]);
  });

  it("numbers claims in document order", () => {
    const doc = parseCv(
      "Intro <!-- ev: ROLE-001 -->\n\n## A\n\n### H <!-- ev: ROLE-002 -->\n\n- b",
    ).doc;
    assert.deepEqual(
      cvClaims(doc).map((c) => [c.n, c.kind, c.section, c.line]),
      [
        [0, "paragraph", "", 1],
        [1, "entry", "A", 5],
        [2, "bullet", "A", 7],
      ],
    );
  });
});
