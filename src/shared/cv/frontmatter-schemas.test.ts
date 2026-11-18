import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BaseCvFrontmatter, TailoredCvFrontmatter } from "../schemas/cv.ts";
import { parseCv } from "./parse.ts";

// The two frontmatter shapes from docs/cv-dialect.md, read through the CV parser.

describe("BaseCvFrontmatter", () => {
  it("accepts the documented example", () => {
    const { doc, issues } = parseCv(
      [
        "---",
        "# profile/bases/em.md",
        "id: em",
        "label: Engineering Manager",
        "track: management              # management | ic",
        "target_titles: [Engineering Manager, Senior Engineering Manager]",
        "headline: Engineering Manager, Platform and Developer Experience",
        "emphasis: [people leadership, delivery, platform]",
        "theme: classic",
        "---",
        "",
        "## Experience",
      ].join("\n"),
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(BaseCvFrontmatter.parse(doc.frontmatter), {
      id: "em",
      label: "Engineering Manager",
      track: "management",
      target_titles: ["Engineering Manager", "Senior Engineering Manager"],
      headline: "Engineering Manager, Platform and Developer Experience",
      emphasis: ["people leadership", "delivery", "platform"],
      theme: "classic",
    });
  });

  it("fills defaults and rejects bad values", () => {
    assert.deepEqual(
      BaseCvFrontmatter.parse({ id: "senior-swe", label: "Senior SWE", track: "ic" }),
      {
        id: "senior-swe",
        label: "Senior SWE",
        track: "ic",
        target_titles: [],
        emphasis: [],
        theme: "classic",
      },
    );
    for (const bad of [
      { id: "EM", label: "x", track: "ic" },
      { id: "em", label: "", track: "ic" },
      { id: "em", label: "x", track: "director" },
      { id: "em", label: "x", track: "ic", theme: "fancy" },
    ]) {
      assert.equal(BaseCvFrontmatter.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});

describe("TailoredCvFrontmatter", () => {
  it("accepts the documented example", () => {
    const sha = "a".repeat(64);
    const { doc, issues } = parseCv(
      [
        "---",
        "job: 2026-11-16_acme_engineering-manager-platform",
        "base: em",
        `base_sha256: ${sha}`,
        "headline: Engineering Manager, Platform",
        "generated_at: 2026-11-16T11:02:00+01:00",
        "engine: { id: anthropic-api, model: claude-opus-5-5 }",
        "---",
        "",
        "## Experience",
      ].join("\n"),
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(TailoredCvFrontmatter.parse(doc.frontmatter), {
      job: "2026-11-16_acme_engineering-manager-platform",
      base: "em",
      base_sha256: sha,
      headline: "Engineering Manager, Platform",
      generated_at: "2026-11-16T11:02:00+01:00",
      engine: { id: "anthropic-api", model: "claude-opus-5-5" },
      theme: "classic",
    });
  });

  it("rejects a missing offset, a bad hash and a bad job id", () => {
    const valid = {
      job: "2026-11-16_acme_em",
      base: "em",
      base_sha256: "b".repeat(64),
      generated_at: "2026-11-16T11:02:00+01:00",
      engine: { id: "claude-code", model: "m" },
    };
    assert.equal(TailoredCvFrontmatter.safeParse(valid).success, true);
    for (const patch of [
      { generated_at: "2026-11-16T11:02:00" },
      { base_sha256: "B".repeat(64) },
      { job: "acme-em" },
      { engine: { id: "x" } },
    ]) {
      const result = TailoredCvFrontmatter.safeParse({ ...valid, ...patch });
      assert.equal(result.success, false, JSON.stringify(patch));
    }
  });
});
