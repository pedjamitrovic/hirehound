import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { joinFrontmatter, normalizeText, splitFrontmatter } from "./frontmatter.ts";

describe("splitFrontmatter", () => {
  it("splits YAML and body", () => {
    const split = splitFrontmatter("---\ntitle: EM\n---\n\nBody line\n");
    assert.equal(split.yaml, "title: EM");
    assert.equal(split.body, "Body line\n");
    assert.equal(split.yamlStartLine, 2);
  });

  it("handles CRLF and a BOM", () => {
    const split = splitFrontmatter("\ufeff---\r\ntitle: EM\r\n---\r\nBody\r\n");
    assert.equal(split.yaml, "title: EM");
    assert.equal(split.body, "Body\n");
  });

  it("accepts empty frontmatter", () => {
    const split = splitFrontmatter("---\n---\nBody");
    assert.equal(split.yaml, "");
    assert.equal(split.body, "Body");
  });

  it("treats files without a leading fence as body only", () => {
    const split = splitFrontmatter("Body\n---\nnot: frontmatter\n---\n");
    assert.equal(split.yaml, null);
    assert.equal(split.body, "Body\n---\nnot: frontmatter\n---\n");
  });
});

describe("joinFrontmatter", () => {
  it("round-trips data and body", () => {
    const data = { company: "Acme", url: `https://example.com/${"a".repeat(120)}` };
    const text = joinFrontmatter(data, "\n\nLine one\nLine two\n\n");
    assert.equal(text.endsWith("Line one\nLine two\n"), true);
    const split = splitFrontmatter(text);
    assert.deepEqual(parse(split.yaml ?? ""), data);
    assert.equal(split.body, "Line one\nLine two\n");
    // Long values are never folded across lines.
    assert.equal((split.yaml ?? "").split("\n").length, 2);
  });

  it("keeps a body that starts with a fence-like line intact", () => {
    const text = joinFrontmatter({ a: 1 }, "---\nnot frontmatter");
    assert.equal(splitFrontmatter(text).body, "---\nnot frontmatter\n");
  });
});

describe("normalizeText", () => {
  it("converts lone CR too", () => {
    assert.equal(normalizeText("a\rb\r\nc"), "a\nb\nc");
  });
});
