import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOB_ID_PATTERN } from "./schemas/common.ts";
import { jobIdFor, slugify } from "./slug.ts";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    assert.equal(slugify("Engineering Manager, Platform"), "engineering-manager-platform");
    assert.equal(slugify("  --Acme  Corp.--  "), "acme-corp");
  });

  it("folds diacritics and spells out ampersands", () => {
    assert.equal(slugify("Zürich Café"), "zurich-cafe");
    assert.equal(slugify("Đorđe Šović"), "djordje-sovic");
    assert.equal(slugify("Łódź Straße"), "lodz-strasse");
    assert.equal(slugify("Procter & Gamble"), "procter-and-gamble");
  });

  it("cuts long input at a word boundary", () => {
    const slug = slugify("Senior Staff Software Engineer, Developer Productivity and Tooling", 30);
    assert.ok(slug.length <= 30);
    assert.equal(slug, "senior-staff-software-engineer");
    assert.doesNotMatch(slug, /-$/);
  });

  it("keeps a stable hash for text without ASCII letters", () => {
    const slug = slugify("Јадран");
    assert.match(slug, /^x-[0-9a-f]{8}$/);
    assert.equal(slugify("Јадран"), slug);
    assert.notEqual(slugify("Морава"), slug);
  });

  it("avoids Windows reserved names", () => {
    assert.equal(slugify("CON"), "con-x");
    assert.equal(slugify("lpt1"), "lpt1-x");
  });
});

describe("jobIdFor", () => {
  it("builds ids that match the JobId schema, with collision suffixes", () => {
    const id = jobIdFor("2026-11-16", "Acme Corp", "Engineering Manager, Platform");
    assert.equal(id, "2026-11-16_acme-corp_engineering-manager-platform");
    assert.match(id, JOB_ID_PATTERN);
    const second = jobIdFor("2026-11-16", "Acme Corp", "Engineering Manager, Platform", 2);
    assert.equal(second, `${id}-2`);
    assert.match(second, JOB_ID_PATTERN);
  });

  it("stays valid for very long names", () => {
    const id = jobIdFor("2026-11-16", "A".repeat(80), "B ".repeat(80), 42);
    assert.match(id, JOB_ID_PATTERN);
  });
});
