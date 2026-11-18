import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeEntities, htmlToText, mainContent } from "./html-text.ts";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    assert.equal(
      decodeEntities("R&amp;D &lt;b&gt; &#39;x&#39; &#x2F; caf&eacute;"),
      "R&D <b> 'x' / caf&eacute;",
    );
    assert.equal(decodeEntities("a&nbsp;b"), "a b");
    assert.equal(decodeEntities("2020 &ndash; 2024"), "2020 \u2013 2024");
    assert.equal(decodeEntities("&#0; &#xFFFFFF;"), "&#0; &#xFFFFFF;");
  });
});

describe("htmlToText", () => {
  it("keeps headings, paragraphs and bullets", () => {
    const html = `
      <h2>About the role</h2>
      <p>We are hiring an <strong>Engineering Manager</strong> for our
         platform team.</p>
      <h3>What you'll do</h3>
      <ul><li>Lead a team of 8</li><li>Own the <a href="#">roadmap</a></li></ul>
      <p>Apply below.</p>`;
    assert.equal(
      htmlToText(html),
      [
        "## About the role",
        "",
        "We are hiring an Engineering Manager for our platform team.",
        "",
        "## What you'll do",
        "",
        "- Lead a team of 8",
        "- Own the roadmap",
        "",
        "Apply below.",
      ].join("\n"),
    );
  });

  it("drops scripts, styles, forms, navigation and comments", () => {
    const html = `<nav>Home Jobs</nav><script>var x = "<p>no</p>";</script><style>p{}</style>
      <!-- hidden --><p>Visible</p><form><label>Name</label><input></form><footer>Legal</footer>`;
    assert.equal(htmlToText(html), "Visible");
  });

  it("does not split words across inline tags but separates table cells", () => {
    assert.equal(htmlToText("<p><b>Re</b>quired</p>"), "Required");
    assert.equal(
      htmlToText("<table><tr><td>Salary</td><td>EUR 90k</td></tr></table>"),
      "Salary EUR 90k",
    );
  });

  it("turns line breaks into separate lines", () => {
    assert.equal(htmlToText("<p>Line one<br>Line two</p>"), "Line one\n\nLine two");
  });

  it("survives broken markup", () => {
    assert.equal(htmlToText("<p>Unclosed <b>bold < 5 years"), "Unclosed bold < 5 years");
    assert.equal(htmlToText("<div><p>a</div></p>b"), "a\n\nb");
    assert.equal(htmlToText(""), "");
  });

  it("skips nested elements of the same skipped type", () => {
    assert.equal(htmlToText("<form><form>x</form>y</form><p>z</p>"), "z");
  });
});

describe("mainContent", () => {
  it("prefers main, then article, then body", () => {
    assert.equal(mainContent("<body><nav>n</nav><main><p>m</p></main></body>"), "<p>m</p>");
    assert.equal(mainContent("<body><article>a</article></body>"), "a");
    assert.equal(mainContent("<html><body>b</body></html>"), "b");
    assert.equal(mainContent("<p>no body</p>"), "<p>no body</p>");
  });
});
