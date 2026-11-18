import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BankId } from "../schemas/common.ts";
import { checkEvidence, cvEvidenceIds } from "./evidence.ts";
import { parseCv } from "./parse.ts";
import { EVIDENCE_ID } from "./syntax.ts";

const CV = [
  "Summary of the candidate. <!-- ev: ROLE-001 -->",
  "",
  "## Experience",
  "",
  "### Lead \u00b7 Acme Robotics <!-- ev: ROLE-003 -->",
  "",
  "- Grew the team <!-- ev: ACH-014, ROLE-003 -->",
  "- Cut latency <!-- ev: ACH-020 -->",
  "- Ran on-call",
  "",
  "<!-- a comment needs no marker -->",
  "",
  "### Speaker",
  "",
  "Talks about platforms. <!-- ev: ACH-999 -->",
].join("\n");

describe("cvEvidenceIds", () => {
  it("lists every cited id once, in order of appearance", () => {
    assert.deepEqual(cvEvidenceIds(parseCv(CV).doc), [
      "ROLE-001",
      "ROLE-003",
      "ACH-014",
      "ACH-020",
      "ACH-999",
    ]);
    assert.deepEqual(cvEvidenceIds(parseCv("## Only a section").doc), []);
  });
});

describe("checkEvidence", () => {
  const known = new Set(["ROLE-001", "ROLE-003", "ACH-014", "ACH-020"]);

  it("warns about missing markers in a base CV and rejects unknown ids", () => {
    assert.deepEqual(checkEvidence(parseCv(CV).doc, known, "base"), [
      { line: 9, col: 1, severity: "warning", message: "Bullet has no evidence marker" },
      { line: 13, col: 1, severity: "warning", message: "Entry heading has no evidence marker" },
      {
        line: 15,
        col: 1,
        severity: "error",
        message: "Unknown evidence id ACH-999; it is not in the experience bank",
      },
    ]);
  });

  it("rejects missing markers in a tailored CV", () => {
    const issues = checkEvidence(parseCv(CV).doc, known, "tailored");
    assert.deepEqual(
      issues.map((issue) => [issue.line, issue.severity]),
      [
        [9, "error"],
        [13, "error"],
        [15, "error"],
      ],
    );
    assert.match(issues[0]?.message ?? "", /^Bullet has no evidence marker; every claim/);
  });

  it("never asks for a marker on a section heading", () => {
    const doc = parseCv("## Experience\n\n## Skills\n\nGo <!-- ev: ACH-014 -->").doc;
    assert.deepEqual(checkEvidence(doc, known, "tailored"), []);
  });

  it("passes a fully cited CV", () => {
    const doc = parseCv("### Lead <!-- ev: ROLE-003 -->\n\n- Grew it <!-- ev: ACH-014 -->").doc;
    assert.deepEqual(checkEvidence(doc, known, "tailored"), []);
    assert.deepEqual(checkEvidence(doc, known, "base"), []);
  });
});

describe("evidence id grammar", () => {
  it("matches the BankId schema", () => {
    for (const id of ["ROLE-003", "ACH-014", "SKL-021", "EDU-001", "AB-123", "ABCDE-123456"]) {
      assert.ok(EVIDENCE_ID.test(id), id);
      assert.ok(BankId.safeParse(id).success, id);
    }
    for (const id of [
      "A-123",
      "ABCDEF-123",
      "ACH-12",
      "ach-014",
      "ACH014",
      "ACH-014a",
      "ACH-\u0661\u0662\u0663",
    ]) {
      assert.equal(EVIDENCE_ID.test(id), false, id);
      assert.equal(BankId.safeParse(id).success, false, id);
    }
  });
});
