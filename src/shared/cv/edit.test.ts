import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cvClaims } from "./claims.ts";
import { escapeCvText, replaceClaimText } from "./edit.ts";
import { parseCv } from "./parse.ts";

const CV = [
  "---",
  "job: x",
  "---",
  "",
  "Summary line one",
  "continues here. <!-- ev: ROLE-001 -->",
  "",
  "## Experience",
  "",
  "### Lead, Acme | 2021 <!-- ev: ROLE-001 -->",
  "",
  "- Grew the team",
  "  from 4 to 14 <!-- ev: ACH-001 -->",
  "- Cut latency <!-- ev: ACH-002 -->",
].join("\n");

describe("replaceClaimText", () => {
  it("replaces a multi-line bullet and keeps its marker", () => {
    const next = replaceClaimText(CV, 12, "bullet", "Grew the team to 14 engineers");
    assert.ok(next);
    const claims = cvClaims(parseCv(next).doc);
    assert.deepEqual(
      claims.map((c) => [c.text, c.ev]),
      [
        ["Summary line one continues here.", ["ROLE-001"]],
        ["Lead, Acme | 2021", ["ROLE-001"]],
        ["Grew the team to 14 engineers", ["ACH-001"]],
        ["Cut latency", ["ACH-002"]],
      ],
    );
  });

  it("replaces paragraphs and entry headings", () => {
    const paragraph = replaceClaimText(CV, 5, "paragraph", "A shorter summary.");
    assert.match(paragraph ?? "", /\nA shorter summary\. <!-- ev: ROLE-001 -->\n\n## Experience/);
    const entry = replaceClaimText(CV, 10, "entry", "Lead, Acme Robotics | 2021");
    assert.match(entry ?? "", /\n### Lead, Acme Robotics \| 2021 <!-- ev: ROLE-001 -->\n/);
  });

  it("escapes formatting characters and refuses a line of the wrong kind", () => {
    assert.equal(
      escapeCvText("Use *care* [here] <b> \\ ok"),
      "Use \\*care\\* \\[here\\] \\<b> \\\\ ok",
    );
    assert.equal(replaceClaimText(CV, 8, "bullet", "x"), null);
    assert.equal(replaceClaimText(CV, 99, "bullet", "x"), null);
  });
});
