import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Requirement } from "./schemas/evaluation.ts";
import { bandFor, computeScore } from "./score.ts";

type R = Pick<Requirement, "weight" | "match" | "source">;
const req = (weight: R["weight"], match: R["match"], source: R["source"] = "jd-wording"): R => ({
  weight,
  match,
  source,
});

describe("computeScore", () => {
  it("is 0 for an empty matrix", () => {
    assert.equal(computeScore([]).score, 0);
  });

  it("weights must 3, strong 2, nice 1 and partial as half", () => {
    // earned 3 + 1 + 0 = 4 of 6
    const result = computeScore([req("must", "met"), req("strong", "partial"), req("nice", "gap")]);
    assert.equal(result.raw, 67);
    assert.equal(result.score, 67);
    assert.equal(result.band, "stretch");
    assert.deepEqual(result.caps, []);
  });

  it("gives 100 for a full firm match", () => {
    const result = computeScore([req("must", "met"), req("nice", "met", "jd-structure")]);
    assert.deepEqual(result, { score: 100, band: "strong", raw: 100, firm: 100, caps: [] });
  });

  it("caps at 84 when only estimates carry the role into the top band", () => {
    const result = computeScore([
      req("must", "met"),
      req("must", "partial"),
      req("must", "met", "estimate"),
      req("must", "met", "estimate"),
    ]);
    // raw = (3 + 1.5 + 3 + 3) / 12 = 87.5 -> 88; firm = 4.5 / 6 = 75
    assert.equal(result.raw, 88);
    assert.equal(result.firm, 75);
    assert.equal(result.score, 84);
    assert.equal(result.band, "good");
    assert.deepEqual(result.caps, ["estimate"]);
  });

  it("does not cap when firm requirements alone reach the top band", () => {
    const result = computeScore([req("must", "met"), req("nice", "partial", "estimate")]);
    assert.equal(result.firm, 100);
    assert.equal(result.score, result.raw);
  });

  it("caps at 69 with an unmet must-have", () => {
    const reqs = [req("must", "gap"), ...Array.from({ length: 10 }, () => req("strong", "met"))];
    const result = computeScore(reqs);
    assert.equal(result.raw, 87);
    assert.equal(result.firm, 87);
    assert.equal(result.score, 69);
    assert.deepEqual(result.caps, ["must-gap"]);
  });

  it("applies both caps in order", () => {
    const result = computeScore([
      req("must", "gap"),
      ...Array.from({ length: 10 }, () => req("strong", "met", "estimate")),
    ]);
    assert.equal(result.firm, 0);
    assert.equal(result.score, 69);
    assert.deepEqual(result.caps, ["estimate", "must-gap"]);
  });
});

describe("bandFor", () => {
  it("maps band edges", () => {
    assert.equal(bandFor(85), "strong");
    assert.equal(bandFor(84), "good");
    assert.equal(bandFor(70), "good");
    assert.equal(bandFor(69), "stretch");
    assert.equal(bandFor(50), "stretch");
    assert.equal(bandFor(49), "weak");
  });
});
