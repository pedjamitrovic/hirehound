import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cvClaims } from "./claims.ts";
import { diffClaims, diffStats } from "./diff.ts";
import { parseCv } from "./parse.ts";

const claims = (text: string) => cvClaims(parseCv(text).doc);

const BASE = [
  "Engineering leader. <!-- ev: ROLE-001 -->",
  "",
  "## Experience",
  "",
  "### Engineering Manager, Acme <!-- ev: ROLE-001 -->",
  "",
  "- Grew the team from 4 to 14 <!-- ev: ACH-001 -->",
  "- Cut latency by 40% <!-- ev: ACH-002 -->",
  "- Ran hiring <!-- ev: ACH-003 -->",
].join("\n");

const SYMBOL = { same: "=", changed: "~", added: "+", removed: "-" } as const;

function summary(base: string, cv: string): string[] {
  return diffClaims(claims(base), claims(cv)).map(
    (d) => `${SYMBOL[d.op]} ${d.op === "removed" ? d.base.text : d.cv.text}`,
  );
}

describe("diffClaims", () => {
  it("reports an identical CV as unchanged", () => {
    const diff = diffClaims(claims(BASE), claims(BASE));
    assert.deepEqual(diffStats(diff), { same: 5, changed: 0, added: 0, removed: 0 });
  });

  it("pairs rewrites of the same fact, even when moved, and keeps the rest apart", () => {
    const cv = [
      "Platform engineering leader. <!-- ev: ROLE-001 -->",
      "",
      "## Experience",
      "",
      "### Engineering Manager, Acme <!-- ev: ROLE-001 -->",
      "",
      "- Cut latency by 40% <!-- ev: ACH-002 -->",
      "- Grew the platform team from 4 to 14 engineers <!-- ev: ACH-001 -->",
      "- Introduced on-call <!-- ev: ACH-009 -->",
    ].join("\n");
    assert.deepEqual(summary(BASE, cv), [
      "~ Platform engineering leader.",
      "= Engineering Manager, Acme",
      "= Cut latency by 40%",
      "- Ran hiring",
      "~ Grew the platform team from 4 to 14 engineers",
      "+ Introduced on-call",
    ]);
    const rewrite = diffClaims(claims(BASE), claims(cv)).find(
      (d) => d.op === "changed" && d.cv.n === 3,
    );
    assert.equal(
      rewrite?.op === "changed" ? rewrite.base.text : null,
      "Grew the team from 4 to 14",
    );
  });

  it("treats a claim that only moved as unchanged", () => {
    const cv = BASE.replace(
      "- Grew the team from 4 to 14 <!-- ev: ACH-001 -->\n- Cut latency by 40% <!-- ev: ACH-002 -->",
      "- Cut latency by 40% <!-- ev: ACH-002 -->\n- Grew the team from 4 to 14 <!-- ev: ACH-001 -->",
    );
    assert.deepEqual(diffStats(diffClaims(claims(BASE), claims(cv))), {
      same: 5,
      changed: 0,
      added: 0,
      removed: 0,
    });
  });

  it("ignores case and spacing, but not a change of evidence", () => {
    const cv = BASE.replace(
      "- Ran hiring <!-- ev: ACH-003 -->",
      "- ran   HIRING <!-- ev: ACH-004 -->",
    ).replace(
      "- Cut latency by 40% <!-- ev: ACH-002 -->",
      "- cut latency by 40% <!-- ev: ACH-002 -->",
    );
    assert.deepEqual(diffStats(diffClaims(claims(BASE), claims(cv))), {
      same: 4,
      changed: 1,
      added: 0,
      removed: 0,
    });
  });
});
