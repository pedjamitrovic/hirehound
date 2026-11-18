import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInlines } from "./inline.ts";
import { parseCv } from "./parse.ts";
import type { Block, Inline, ParseIssue } from "./types.ts";

const t = (v: string): Inline => ({ t: "text", v });
const strong = (...c: Inline[]): Inline => ({ t: "strong", c });
const em = (...c: Inline[]): Inline => ({ t: "em", c });
const link = (href: string, ...c: Inline[]): Inline => ({ t: "link", href, c });

const errors = (issues: ParseIssue[]) => issues.filter((issue) => issue.severity === "error");
const lines = (...rows: string[]) => rows.join("\n");

const BASE_CV = lines(
  "---",
  "id: em",
  "label: Engineering Manager",
  "track: management",
  "target_titles: [Engineering Manager, Senior Engineering Manager]",
  "headline: Engineering Manager, Platform and Developer Experience",
  "emphasis: [people leadership, delivery, platform]",
  "theme: classic",
  "---",
  "",
  "Engineering manager with **ten years** of building platform teams. <!-- ev: ROLE-001 -->",
  "",
  "## Experience",
  "",
  "### Engineering Manager \u00b7 Acme Robotics \u00b7 2021-03 - present <!-- ev: ROLE-003 -->",
  "",
  "- Grew the platform team from 4 to 14 engineers in 18 months <!-- ev: ACH-014 -->",
  "* Cut p95 API latency by 40% by moving hot paths to Go",
  "  and caching config reads <!-- ev: ACH-020,ACH-021 -->",
  "+ Ran the *incident review* rotation",
  "",
  "<!-- Older roles trimmed for this base. -->",
  "",
  "## Education",
  "",
  "### MSc Computer Science \u00b7 Example University \u00b7 2012 <!-- ev: EDU-001 -->",
  "",
  "## Skills",
  "",
  "**Languages:** Go, TypeScript, SQL. Talks at [example.org](https://example.org/talks).",
  "<!-- ev: SKL-021 -->",
  "",
);

describe("parseCv", () => {
  it("parses a base CV into the expected AST", () => {
    const { doc, issues } = parseCv(BASE_CV);
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.frontmatter, {
      id: "em",
      label: "Engineering Manager",
      track: "management",
      target_titles: ["Engineering Manager", "Senior Engineering Manager"],
      headline: "Engineering Manager, Platform and Developer Experience",
      emphasis: ["people leadership", "delivery", "platform"],
      theme: "classic",
    });
    const expected: Block[] = [
      {
        t: "paragraph",
        text: [
          t("Engineering manager with "),
          strong(t("ten years")),
          t(" of building platform teams."),
        ],
        ev: ["ROLE-001"],
        line: 11,
      },
      { t: "section", text: [t("Experience")], line: 13 },
      {
        t: "entry",
        text: [t("Engineering Manager \u00b7 Acme Robotics \u00b7 2021-03 - present")],
        ev: ["ROLE-003"],
        line: 15,
      },
      {
        t: "list",
        items: [
          {
            text: [t("Grew the platform team from 4 to 14 engineers in 18 months")],
            ev: ["ACH-014"],
            line: 17,
          },
          {
            text: [
              t("Cut p95 API latency by 40% by moving hot paths to Go and caching config reads"),
            ],
            ev: ["ACH-020", "ACH-021"],
            line: 18,
          },
          { text: [t("Ran the "), em(t("incident review")), t(" rotation")], ev: [], line: 20 },
        ],
      },
      { t: "comment", v: "Older roles trimmed for this base.", line: 22 },
      { t: "section", text: [t("Education")], line: 24 },
      {
        t: "entry",
        text: [t("MSc Computer Science \u00b7 Example University \u00b7 2012")],
        ev: ["EDU-001"],
        line: 26,
      },
      { t: "section", text: [t("Skills")], line: 28 },
      {
        t: "paragraph",
        text: [
          strong(t("Languages:")),
          t(" Go, TypeScript, SQL. Talks at "),
          link("https://example.org/talks", t("example.org")),
          t("."),
        ],
        ev: ["SKL-021"],
        line: 30,
      },
    ];
    assert.deepEqual(doc.blocks, expected);
  });

  it("reads CRLF line endings and a BOM like LF", () => {
    const crlf = `\ufeff${BASE_CV.replace(/\n/g, "\r\n")}`;
    assert.deepEqual(parseCv(crlf), parseCv(BASE_CV));
  });

  it("accepts a file without frontmatter or with empty frontmatter", () => {
    assert.deepEqual(parseCv("## Skills\n"), {
      doc: { frontmatter: {}, blocks: [{ t: "section", text: [t("Skills")], line: 1 }] },
      issues: [],
    });
    const empty = parseCv("---\n---\n\n## Skills");
    assert.deepEqual(empty.doc.frontmatter, {});
    assert.deepEqual(empty.issues, []);
    assert.equal(empty.doc.blocks[0]?.t === "section" && empty.doc.blocks[0].line, 4);
    assert.deepEqual(parseCv(""), { doc: { frontmatter: {}, blocks: [] }, issues: [] });
  });

  it("numbers body lines from the top of the file", () => {
    const { doc } = parseCv("---\nid: em\n---\n\n\n\n## Skills\n\nGo");
    assert.deepEqual(
      doc.blocks.map((block) => (block.t === "list" ? 0 : block.line)),
      [7, 9],
    );
  });

  it("reports frontmatter problems on the right line", () => {
    const duplicate = parseCv("---\nid: em\nid: other\n---\n\n## Skills");
    assert.equal(duplicate.issues.length, 1);
    assert.equal(duplicate.issues[0]?.line, 3);
    assert.match(duplicate.issues[0]?.message ?? "", /^Frontmatter YAML: /);
    assert.deepEqual(duplicate.doc.frontmatter, {});
    assert.equal(duplicate.doc.blocks.length, 1);

    const list = parseCv("---\n- a\n- b\n---\n## Skills");
    assert.deepEqual(errors(list.issues), [
      {
        line: 2,
        col: 1,
        severity: "error",
        message: "Frontmatter must be a YAML mapping of keys to values",
      },
    ]);

    const unclosed = parseCv("---\nid: em\n\n## Skills");
    assert.deepEqual(
      unclosed.issues.map((issue) => [issue.line, issue.message]),
      [[1, "Frontmatter is not closed; add a --- line after it"]],
    );
  });

  it("joins paragraph lines and bullet continuation lines with one space", () => {
    const { doc, issues } = parseCv(
      lines("First line", "  second line", "third line", "", "- Bullet", "  continues", "    here"),
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.blocks, [
      { t: "paragraph", text: [t("First line second line third line")], ev: [], line: 1 },
      { t: "list", items: [{ text: [t("Bullet continues here")], ev: [], line: 5 }] },
    ]);
  });

  it("normalises * and + bullets and lets a list interrupt a paragraph", () => {
    const { doc, issues } = parseCv(lines("Intro", "* one", "+ two", "-\tthree"));
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.blocks, [
      { t: "paragraph", text: [t("Intro")], ev: [], line: 1 },
      {
        t: "list",
        items: [
          { text: [t("one")], ev: [], line: 2 },
          { text: [t("two")], ev: [], line: 3 },
          { text: [t("three")], ev: [], line: 4 },
        ],
      },
    ]);
  });

  it("starts a new list after a blank line", () => {
    const { doc } = parseCv(lines("- a", "", "- b"));
    assert.deepEqual(
      doc.blocks.map((block) => block.t),
      ["list", "list"],
    );
  });

  it("warns when an unindented line follows a bullet", () => {
    const { doc, issues } = parseCv(lines("- a bullet", "not indented"));
    assert.deepEqual(
      issues.map((issue) => [issue.line, issue.severity]),
      [[2, "warning"]],
    );
    assert.deepEqual(
      doc.blocks.map((block) => block.t),
      ["list", "paragraph"],
    );
  });

  it("ignores trailing whitespace at the end of a block", () => {
    const { doc, issues } = parseCv("## Skills   \nGo, SQL  \n");
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.blocks[1], { t: "paragraph", text: [t("Go, SQL")], ev: [], line: 2 });
  });

  it("keeps standalone comments, including multi-line ones", () => {
    const { doc, issues } = parseCv(lines("<!--", "## Old job", "- Did things", "-->", "Text"));
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.blocks, [
      { t: "comment", v: "## Old job\n- Did things", line: 1 },
      { t: "paragraph", text: [t("Text")], ev: [], line: 5 },
    ]);
  });

  describe("rejects unsupported syntax with a line-numbered error", () => {
    const cases: { name: string; input: string; line: number; col: number; message: RegExp }[] = [
      { name: "# heading", input: "# Jane Doe", line: 1, col: 1, message: /^# headings/ },
      { name: "#### heading", input: "Text\n\n#### Deep", line: 3, col: 1, message: /^####/ },
      { name: "indented nested list", input: "- a\n  - b", line: 2, col: 3, message: /^Nested/ },
      { name: "inline nested list", input: "- a\n- - b", line: 2, col: 3, message: /^Nested/ },
      {
        name: "ordered list",
        input: "Text\n\n1. one\n2. two",
        line: 3,
        col: 1,
        message: /^Ordered/,
      },
      {
        name: "table",
        input: "| a | b |\n|---|---|\n| 1 | 2 |",
        line: 1,
        col: 1,
        message: /^Tables/,
      },
      {
        name: "fenced code",
        input: "Text\n```\ncode\n```",
        line: 2,
        col: 1,
        message: /^Code blocks/,
      },
      { name: "indented code", input: "    code", line: 1, col: 5, message: /^Indented code/ },
      {
        name: "image",
        input: "See ![logo](https://example.com/logo.png)",
        line: 1,
        col: 5,
        message: /^Images/,
      },
      { name: "raw HTML", input: "- Led <br> ops", line: 1, col: 7, message: /^Raw HTML/ },
      {
        name: "autolink",
        input: "Site <https://example.com>",
        line: 1,
        col: 6,
        message: /^Autolinks/,
      },
      {
        name: "hard break (spaces)",
        input: "One  \ntwo",
        line: 1,
        col: 4,
        message: /trailing spaces$/,
      },
      {
        name: "hard break (backslash)",
        input: "One\\\ntwo",
        line: 1,
        col: 4,
        message: /backslash$/,
      },
      { name: "block quote", input: "> quoted", line: 1, col: 1, message: /^Block quotes/ },
      { name: "horizontal rule", input: "Text\n\n***", line: 3, col: 1, message: /^Horizontal/ },
      { name: "setext heading", input: "Title\n=====", line: 2, col: 1, message: /^Underlined/ },
      {
        name: "unclosed comment",
        input: "Text\n\n<!-- open\nstill",
        line: 3,
        col: 1,
        message: /never closed/,
      },
      {
        name: "link scheme",
        input: "Text\n\n- See [it](ftp://example.com/x)",
        line: 3,
        col: 7,
        message: /^Links must use http, https or mailto/,
      },
    ];
    for (const { name, input, line, col, message } of cases) {
      it(name, () => {
        const found = errors(parseCv(input).issues);
        assert.equal(found.length, 1, JSON.stringify(found));
        assert.equal(found[0]?.line, line);
        assert.equal(found[0]?.col, col);
        assert.match(found[0]?.message ?? "", message);
      });
    }
  });

  it("keeps a best-effort AST around unsupported syntax", () => {
    const { doc } = parseCv(
      lines(
        "# Jane Doe",
        "",
        "#### Deep",
        "",
        "1. one",
        "2. two",
        "",
        "```",
        "x = 1",
        "```",
        "",
        "> q",
      ),
    );
    assert.deepEqual(doc.blocks, [
      { t: "section", text: [t("Jane Doe")], line: 1 },
      { t: "entry", text: [t("Deep")], ev: [], line: 3 },
      {
        t: "list",
        items: [
          { text: [t("one")], ev: [], line: 5 },
          { text: [t("two")], ev: [], line: 6 },
        ],
      },
      { t: "paragraph", text: [t("x = 1")], ev: [], line: 9 },
      { t: "paragraph", text: [t("q")], ev: [], line: 12 },
    ]);
    const html = parseCv("Led <b>ops</b> and [it](ftp://x.example)");
    assert.deepEqual(html.doc.blocks, [
      { t: "paragraph", text: [t("Led <b>ops</b> and [it](ftp://x.example)")], ev: [], line: 1 },
    ]);
  });

  it("does not treat a number inside a paragraph as an ordered list", () => {
    const { doc, issues } = parseCv("Joined in March\n2021. Led the move");
    assert.deepEqual(issues, []);
    assert.deepEqual(doc.blocks, [
      { t: "paragraph", text: [t("Joined in March 2021. Led the move")], ev: [], line: 1 },
    ]);
  });
});

describe("evidence markers", () => {
  const evOf = (input: string) => {
    const { doc, issues } = parseCv(input);
    const block = doc.blocks[0];
    const ev = block?.t === "list" ? block.items[0]?.ev : block && "ev" in block ? block.ev : [];
    return { ev, issues, doc };
  };

  it("attaches ids to entry headings, paragraphs and bullets", () => {
    assert.deepEqual(evOf("### Lead <!-- ev: ROLE-003 -->").ev, ["ROLE-003"]);
    assert.deepEqual(evOf("Summary <!-- ev: ROLE-001 -->").ev, ["ROLE-001"]);
    assert.deepEqual(evOf("- Did it <!-- ev: ACH-014 -->").ev, ["ACH-014"]);
    const { doc } = evOf("- Did it <!-- ev: ACH-014 -->");
    assert.deepEqual(doc.blocks, [
      { t: "list", items: [{ text: [t("Did it")], ev: ["ACH-014"], line: 1 }] },
    ]);
  });

  it("accepts several ids and whitespace variants", () => {
    for (const marker of [
      "<!-- ev: ACH-020, ACH-021 -->",
      "<!-- ev: ACH-020,ACH-021 -->",
      "<!--ev:ACH-020 , ACH-021-->",
      "<!--\tev:\tACH-020,\tACH-021\t-->",
    ]) {
      const { ev, issues } = evOf(`- Cut latency ${marker}`);
      assert.deepEqual(issues, [], marker);
      assert.deepEqual(ev, ["ACH-020", "ACH-021"], marker);
    }
    assert.deepEqual(evOf("- x <!-- ev: SKILL-12345 -->").ev, ["SKILL-12345"]);
  });

  it("accepts a marker on a line of its own that continues the block", () => {
    assert.deepEqual(evOf("Summary line\n<!-- ev: ROLE-001 -->").ev, ["ROLE-001"]);
    const bullet = evOf("- Did it\n  <!-- ev: ACH-014 -->");
    assert.deepEqual(bullet.ev, ["ACH-014"]);
    assert.deepEqual(bullet.issues, []);
  });

  it("rejects a marker on a section heading", () => {
    const { doc, issues } = parseCv("## Skills <!-- ev: SKL-021 -->");
    assert.deepEqual(doc.blocks, [{ t: "section", text: [t("Skills")], line: 1 }]);
    assert.deepEqual(errors(issues), [
      { line: 1, col: 11, severity: "error", message: "Section headings take no evidence marker" },
    ]);
  });

  it("rejects a second marker", () => {
    const { ev, issues } = evOf("- Did it <!-- ev: ACH-001 --> <!-- ev: ACH-002 -->");
    assert.deepEqual(errors(issues), [
      {
        line: 1,
        col: 31,
        severity: "error",
        message: "A bullet takes one evidence marker; list every id in it",
      },
    ]);
    assert.deepEqual(ev, ["ACH-001", "ACH-002"]);
  });

  it("rejects malformed markers", () => {
    for (const marker of [
      "<!-- ev: -->",
      "<!-- ev: ach-1 -->",
      "<!-- ev: ACH-1 -->",
      "<!-- ev: ACH-014, -->",
      "<!-- ev: ACH-014 ACH-015 -->",
      "<!-- EV: ACH-014 -->",
    ]) {
      const { ev, issues } = evOf(`- Did it ${marker}`);
      assert.deepEqual(
        errors(issues).map((issue) => [issue.line, issue.col, issue.message.split(";")[0]]),
        [[1, 10, "Malformed evidence marker"]],
        marker,
      );
      assert.deepEqual(ev, [], marker);
    }
  });

  it("rejects a marker in the middle of text or before the last line", () => {
    const middle = evOf("- Did <!-- ev: ACH-014 --> things");
    assert.deepEqual(
      errors(middle.issues).map((issue) => [issue.line, issue.col, issue.message]),
      [[1, 7, "The evidence marker must come at the end of the bullet"]],
    );
    const earlier = evOf("Line one <!-- ev: ACH-014 -->\nline two");
    assert.deepEqual(
      errors(earlier.issues).map((issue) => [issue.line, issue.col]),
      [[1, 10]],
    );
  });

  it("rejects a marker standing alone between blocks", () => {
    const { doc, issues } = parseCv("## Skills\n<!-- ev: SKL-001 -->");
    assert.deepEqual(
      errors(issues).map((issue) => issue.line),
      [2],
    );
    assert.deepEqual(doc.blocks[1], { t: "comment", v: "ev: SKL-001", line: 2 });
  });

  it("rejects comments inside text", () => {
    const { ev, issues, doc } = evOf("Text <!-- note --> more");
    assert.deepEqual(
      errors(issues).map((issue) => [issue.col, issue.message]),
      [[6, "Comments go on their own line, not inside text"]],
    );
    assert.deepEqual(ev, []);
    assert.deepEqual(doc.blocks[0], {
      t: "paragraph",
      text: [t("Text  more")],
      ev: [],
      line: 1,
    });
  });

  it("warns about an id cited twice and keeps it once", () => {
    const { ev, issues } = evOf("- x <!-- ev: ACH-001, ACH-001 -->");
    assert.deepEqual(ev, ["ACH-001"]);
    assert.deepEqual(
      issues.map((issue) => issue.severity),
      ["warning"],
    );
  });

  it("treats an escaped marker as text", () => {
    const { ev, issues, doc } = evOf("- Literal \\<!-- ev: ACH-001 -->");
    assert.deepEqual(issues, []);
    assert.deepEqual(ev, []);
    assert.deepEqual(doc.blocks, [
      { t: "list", items: [{ text: [t("Literal <!-- ev: ACH-001 -->")], ev: [], line: 1 }] },
    ]);
  });
});

describe("parseInlines", () => {
  const parse = (s: string) => parseInlines(s);

  it("parses strong, em and links", () => {
    assert.deepEqual(parse("**bold** and *em*").nodes, [
      strong(t("bold")),
      t(" and "),
      em(t("em")),
    ]);
    assert.deepEqual(parse("[site](https://acme.example/a_(b))").nodes, [
      link("https://acme.example/a_(b)", t("site")),
    ]);
    assert.deepEqual(parse("[mail](mailto:jo@example.com) [h](http://x.example)").nodes, [
      link("mailto:jo@example.com", t("mail")),
      t(" "),
      link("http://x.example", t("h")),
    ]);
  });

  it("supports nesting", () => {
    assert.deepEqual(parse("**bold *nested* text**").nodes, [
      strong(t("bold "), em(t("nested")), t(" text")),
    ]);
    assert.deepEqual(parse("*em **strong** em*").nodes, [
      em(t("em "), strong(t("strong")), t(" em")),
    ]);
    assert.deepEqual(parse("***both***").nodes, [strong(em(t("both")))]);
    assert.deepEqual(parse("[**Acme** *site*](https://acme.example)").nodes, [
      link("https://acme.example", strong(t("Acme")), t(" "), em(t("site"))),
    ]);
    assert.deepEqual(parse("**[Acme](https://acme.example)**").nodes, [
      strong(link("https://acme.example", t("Acme"))),
    ]);
  });

  it("does not nest links", () => {
    assert.deepEqual(parse("[a [b](https://b.example) c](https://c.example)").nodes, [
      link("https://c.example", t("a [b](https://b.example) c")),
    ]);
  });

  it("applies backslash escapes", () => {
    assert.deepEqual(parse("\\*not em\\* \\[x\\] \\\\ \\<b>").nodes, [t("*not em* [x] \\ <b>")]);
    assert.deepEqual(parse("C:\\path\\to \\n end\\").nodes, [t("C:\\path\\to \\n end\\")]);
  });

  it("keeps unmatched markup as text", () => {
    for (const s of [
      "a * b",
      "**unclosed",
      "*open",
      "close*",
      "* spaced *",
      "**",
      "****",
      "[a](b",
      "[a]",
      "[a] (https://x.example)",
      "[](https://x.example)",
      "a < b > c",
      "x<y",
      "snake_case and __dunder__",
      "`code`",
    ]) {
      const { nodes, issues } = parse(s);
      assert.deepEqual(nodes, [t(s)], s);
      assert.deepEqual(issues, [], s);
    }
  });

  it("reports links to other schemes and keeps them as text", () => {
    for (const href of [
      "ftp://x.example",
      "javascript:alert(1)",
      "/relative",
      "#anchor",
      "www.x.example",
    ]) {
      const s = `see [it](${href})`;
      const { nodes, issues } = parse(s);
      assert.deepEqual(nodes, [t(s)], href);
      assert.deepEqual(issues, [
        { pos: 4, message: `Links must use http, https or mailto: ${href}` },
      ]);
    }
  });

  it("reports raw HTML, autolinks and inline comments", () => {
    assert.deepEqual(
      parse("<br> <span class='x'> </div> <!DOCTYPE html> <me@example.com> <!-- x").issues.map(
        (issue) => [issue.pos, issue.message.split(";")[0]],
      ),
      [
        [0, "Raw HTML is not supported"],
        [5, "Raw HTML is not supported"],
        [22, "Raw HTML is not supported"],
        [29, "Raw HTML is not supported"],
        [45, "Autolinks are not supported"],
        [62, "Unclosed comment"],
      ],
    );
  });

  it("stays fast on pathological input", () => {
    const started = Date.now();
    parse(`${"**a ".repeat(400)}${"*".repeat(2000)}${"[".repeat(500)}`);
    parse("*a ".repeat(1000));
    assert.ok(Date.now() - started < 2000);
  });
});

describe("parseCv robustness", () => {
  it("never throws on arbitrary input", () => {
    const alphabet = [
      "#",
      "-",
      "*",
      "+",
      " ",
      "\n",
      "\t",
      "[",
      "]",
      "(",
      ")",
      "<",
      ">",
      "!",
      "`",
      "|",
    ];
    alphabet.push("<!--", "-->", "ev:", "ACH-001", "\\", "1.", "a", "---", "\r\n", "\ufeff");
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 300; n++) {
      let s = "";
      for (let i = 0; i < 80; i++) s += alphabet[Math.floor(next() * alphabet.length)];
      const result = parseCv(s);
      assert.ok(Array.isArray(result.doc.blocks));
      for (const issue of result.issues) {
        assert.ok(issue.line >= 1 && issue.col >= 1, JSON.stringify({ s, issue }));
        assert.doesNotMatch(issue.message, /^Could not read/, JSON.stringify(s));
      }
    }
  });
});
