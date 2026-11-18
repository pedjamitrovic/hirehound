import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCv } from "./parse.ts";
import { cvPlainText, renderCvHtml } from "./render.ts";
import type { CvDoc } from "./types.ts";

const SAMPLE = [
  "---",
  "id: em",
  "---",
  "Platform leader & mentor. <!-- ev: ROLE-001 -->",
  "",
  "<!-- private note: ask Sam about dates -->",
  "",
  "## Experience",
  "",
  "### Lead \u00b7 Acme Robotics \u00b7 2021 - present <!-- ev: ROLE-003 -->",
  "",
  "- Cut p95 latency by **40%** <!-- ev: ACH-020, ACH-021 -->",
  "- Wrote [the *runbook*](https://acme.example/run?a=1&b=2) <!-- ev: ACH-022 -->",
  "",
  "## Contact",
  "",
  "[Mail](mailto:jo@example.com) or [https://jo.example](https://jo.example)",
].join("\n");

describe("renderCvHtml", () => {
  it("renders sections, entries, paragraphs, lists and inline markup", () => {
    const { doc, issues } = parseCv(SAMPLE);
    assert.deepEqual(issues, []);
    assert.equal(
      renderCvHtml(doc),
      [
        '<section class="cv-section cv-intro">',
        "<p>Platform leader &amp; mentor.</p>",
        "</section>",
        '<section class="cv-section">',
        "<h2>Experience</h2>",
        '<h3 class="cv-entry">Lead \u00b7 Acme Robotics \u00b7 2021 - present</h3>',
        "<ul>",
        "<li>Cut p95 latency by <strong>40%</strong></li>",
        '<li>Wrote <a href="https://acme.example/run?a=1&amp;b=2" rel="noopener noreferrer">the <em>runbook</em></a></li>',
        "</ul>",
        "</section>",
        '<section class="cv-section">',
        "<h2>Contact</h2>",
        '<p><a href="mailto:jo@example.com" rel="noopener noreferrer">Mail</a> or <a href="https://jo.example" rel="noopener noreferrer">https://jo.example</a></p>',
        "</section>",
      ].join("\n"),
    );
  });

  it("never renders evidence markers or comments", () => {
    const { doc } = parseCv(SAMPLE);
    for (const output of [renderCvHtml(doc), cvPlainText(doc)]) {
      assert.doesNotMatch(output, /ev:|ROLE-|ACH-|<!--|-->|private note/);
    }
  });

  it("escapes text and attributes", () => {
    const doc: CvDoc = {
      frontmatter: {},
      blocks: [
        { t: "section", text: [{ t: "text", v: `<script>alert("x")</script> & 'y'` }], line: 1 },
        {
          t: "paragraph",
          text: [
            {
              t: "link",
              href: `https://x.example/?q="a"&r='b'<c>`,
              c: [{ t: "text", v: "<b>" }],
            },
          ],
          ev: [],
          line: 2,
        },
      ],
    };
    assert.equal(
      renderCvHtml(doc),
      [
        '<section class="cv-section">',
        "<h2>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;</h2>",
        // An href with < or > is not an allowed link, so only its text is rendered.
        "<p>&lt;b&gt;</p>",
        "</section>",
      ].join("\n"),
    );
    const quoted: CvDoc = {
      frontmatter: {},
      blocks: [
        {
          t: "paragraph",
          text: [{ t: "link", href: `https://x.example/?q="a"&r='b'`, c: [{ t: "text", v: "x" }] }],
          ev: [],
          line: 1,
        },
      ],
    };
    assert.match(
      renderCvHtml(quoted),
      /<a href="https:\/\/x\.example\/\?q=&quot;a&quot;&amp;r=&#39;b&#39;" rel="noopener noreferrer">x<\/a>/,
    );
  });

  it("renders text the parser kept from rejected syntax as escaped text", () => {
    const html = renderCvHtml(parseCv("Led <b>ops</b> and [it](javascript:alert(1))").doc);
    assert.equal(
      html,
      '<section class="cv-section cv-intro">\n<p>Led &lt;b&gt;ops&lt;/b&gt; and [it](javascript:alert(1))</p>\n</section>',
    );
  });

  it("drops links with other schemes from hand-built ASTs", () => {
    const doc: CvDoc = {
      frontmatter: {},
      blocks: [
        {
          t: "paragraph",
          text: [{ t: "link", href: "javascript:alert(1)", c: [{ t: "text", v: "click" }] }],
          ev: [],
          line: 1,
        },
      ],
    };
    assert.equal(
      renderCvHtml(doc),
      '<section class="cv-section cv-intro">\n<p>click</p>\n</section>',
    );
  });

  it("renders an empty document as an empty string", () => {
    assert.equal(renderCvHtml({ frontmatter: {}, blocks: [] }), "");
    assert.equal(renderCvHtml(parseCv("<!-- only a comment -->").doc), "");
  });
});

describe("cvPlainText", () => {
  it("writes readable text without markup", () => {
    assert.equal(
      cvPlainText(parseCv(SAMPLE).doc),
      [
        "Platform leader & mentor.",
        "",
        "Experience",
        "",
        "Lead \u00b7 Acme Robotics \u00b7 2021 - present",
        "",
        "- Cut p95 latency by 40%",
        "- Wrote the runbook (https://acme.example/run?a=1&b=2)",
        "",
        "Contact",
        "",
        "Mail (jo@example.com) or https://jo.example",
      ].join("\n"),
    );
  });
});
