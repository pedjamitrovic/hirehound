import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCv } from "./parse.ts";
import { serializeCv } from "./serialize.ts";
import type { CvDoc, Inline } from "./types.ts";

const t = (v: string): Inline => ({ t: "text", v });
const strong = (...c: Inline[]): Inline => ({ t: "strong", c });
const em = (...c: Inline[]): Inline => ({ t: "em", c });
const link = (href: string, ...c: Inline[]): Inline => ({ t: "link", href, c });

/** The AST without line numbers, which a round trip is allowed to change. */
function shape(doc: CvDoc): unknown {
  return JSON.parse(JSON.stringify(doc, (key, value) => (key === "line" ? undefined : value)));
}

const errorCount = (text: string) =>
  parseCv(text).issues.filter((issue) => issue.severity === "error").length;

/** serialize(parse(x)) is a fixed point and parse(serialize(ast)) gives the AST back. */
function assertStable(input: string): string {
  const first = parseCv(input);
  const canonical = serializeCv(first.doc);
  const second = parseCv(canonical);
  assert.deepEqual(shape(second.doc), shape(first.doc), `AST changed for ${JSON.stringify(input)}`);
  assert.equal(serializeCv(second.doc), canonical, `not idempotent for ${JSON.stringify(input)}`);
  if (errorCount(input) === 0) {
    assert.equal(errorCount(canonical), 0, `new errors for ${JSON.stringify(input)}`);
  }
  return canonical;
}

describe("serializeCv", () => {
  it("writes the canonical form", () => {
    const input = [
      "---",
      "id: em",
      "label: Engineering Manager # a YAML comment",
      "track: management",
      "---",
      "Summary line one",
      "  and line two.   <!--ev:ROLE-001-->",
      "## Experience",
      "### Lead \u00b7 Acme Robotics \u00b7 2021 - present <!-- ev: ROLE-003 -->",
      "* Grew the team <!-- ev: ACH-014 -->",
      "+ Cut latency by 40%",
      "  for every region <!-- ev: ACH-020 ,ACH-021 -->",
      "<!--",
      "  Old roles",
      "-->",
      "",
      "",
      "## Skills",
      "Go, `SQL`, 5 \\* 3 and \\[brackets\\]",
    ].join("\r\n");
    assert.equal(
      assertStable(input),
      [
        "---",
        "id: em",
        "label: Engineering Manager",
        "track: management",
        "---",
        "",
        "Summary line one and line two. <!-- ev: ROLE-001 -->",
        "",
        "## Experience",
        "",
        "### Lead \u00b7 Acme Robotics \u00b7 2021 - present <!-- ev: ROLE-003 -->",
        "",
        "- Grew the team <!-- ev: ACH-014 -->",
        "- Cut latency by 40% for every region <!-- ev: ACH-020, ACH-021 -->",
        "",
        "<!-- Old roles -->",
        "",
        "## Skills",
        "",
        "Go, `SQL`, 5 \\* 3 and \\[brackets\\]",
        "",
      ].join("\n"),
    );
  });

  it("writes no frontmatter when it is empty", () => {
    assert.equal(serializeCv({ frontmatter: {}, blocks: [] }), "");
    assert.equal(serializeCv({ frontmatter: { id: "em" }, blocks: [] }), "---\nid: em\n---\n");
    assert.equal(assertStable("---\n---\n\n## Skills"), "## Skills\n");
  });

  it("keeps empty headings and bullets stable", () => {
    assert.equal(
      assertStable("##\n\n###\n\n-\n- <!-- ev: ACH-001 -->"),
      "##\n\n###\n\n-\n- <!-- ev: ACH-001 -->\n",
    );
  });

  describe("is stable on varied input", () => {
    const inputs = [
      "## Experience\n\n### Role <!-- ev: ROLE-001 -->\n\n- a <!-- ev: ACH-001 -->\n- b",
      "**bold *em* bold** and *em **strong** em* and ***both***",
      "[**Acme** *site*](https://acme.example/a_(b)) and [mail](mailto:jo@example.com)",
      "Escapes \\* \\[ \\] \\\\ \\< and literal \\n C:\\path end\\",
      "Literal <!-- in text --> and \\<!-- ev: ACH-001 --> escaped",
      "Ends with a backslash \\\\",
      "Unmatched * and ** and [ and ] and a < b",
      "x<y and <b>tags</b> and <https://x.example> and <!DOCTYPE>",
      "[bad](ftp://x.example) and ![img](https://x.example/i.png)",
      "*a **b***",
      "***a** b*",
      "**a* b*",
      "*foo**bar*",
      "****",
      "- - nested\n  - more\n1. ordered",
      "# Name\n\n#### Deep\n\n> quote\n\n| a | b |\n|---|---|\n\n```\ncode\n```",
      "Para\n<!-- ev: ACH-001 -->\n\n- item\n  <!-- ev: ACH-002 -->",
      "<!-- ev: ACH-001 -->\n\n<!--\n  multi\n    line\n-->\n\n<!-- -->",
      "## Skills <!-- ev: SKL-001 -->\n\nText <!-- ev: A --> <!-- ev: ACH-001 -->",
      "Title\n=====\n\n---\n\n***",
      "- a\n\n- b\n\n- c",
      "A paragraph\nthat wraps\n  over lines  \nwith odd spacing",
    ];
    for (const input of inputs) {
      it(JSON.stringify(input).slice(0, 60), () => {
        assertStable(input);
      });
    }
  });

  it("round-trips hand-built ASTs with characters that need escaping", () => {
    const doc: CvDoc = {
      frontmatter: { job: "2026-11-16_acme_em", engine: { id: "anthropic-api", model: "m" } },
      blocks: [
        { t: "section", text: [t("R&D * [x] <b> \\")], line: 1 },
        {
          t: "entry",
          text: [t("Lead "), em(t("a*b")), t(" "), strong(t("\\"), em(t("x")))],
          ev: ["ROLE-001"],
          line: 2,
        },
        {
          t: "paragraph",
          text: [
            t("Text with <!-- ev: ACH-001 --> inside, a\\*b, 1 < 2, a <b> tag, x\\"),
            link("https://x.example/?q=(1)", t("li]n[k"), strong(t("b"))),
          ],
          ev: ["ACH-001", "ACH-002"],
          line: 3,
        },
        {
          t: "list",
          items: [
            { text: [t("*star first")], ev: [], line: 4 },
            { text: [t("ends with a star *")], ev: ["ACH-003"], line: 5 },
          ],
        },
        { t: "comment", v: "first\n  second", line: 6 },
        { t: "comment", v: "single", line: 7 },
      ],
    };
    const text = serializeCv(doc);
    const back = parseCv(text);
    assert.deepEqual(back.issues, []);
    assert.deepEqual(shape(back.doc), shape(doc));
    assert.equal(serializeCv(back.doc), text);
  });

  // Property tests. The round trip is guaranteed for every file that parses without errors; a
  // file with errors gets a best-effort AST that is shown, never saved, so only "no crash" holds.
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

  const INLINE = ["a", "bc", " ", " ", "*", "**", "[", "]", "(", ")", "](https://x.example)"];
  INLINE.push("[x](mailto:a@x.example)", "\\", "\\*", "\\[", "\\\\", "\\<", "<", "< ", "!", "_");
  INLINE.push("`", "-", "#", "1.", "|", ">", "-->", "x<y", "ev:", "ACH-001", "\t");
  const MARKERS = ["", "", " <!-- ev: ACH-001 -->", " <!--ev:SKL-010,ACH-002-->"];
  const inline = () => {
    let text = "";
    const length = 1 + Math.floor(random() * 12);
    for (let i = 0; i < length; i++) text += pick(INLINE);
    return text;
  };
  const LINES = [
    () => `## ${inline()}`,
    () => `### ${inline()}${pick(MARKERS)}`,
    () => `- ${inline()}${pick(MARKERS)}`,
    () => `* ${inline()}${pick(MARKERS)}`,
    () => `  ${inline()}${pick(MARKERS)}`,
    () => `${inline()}${pick(MARKERS)}`,
    () => `${inline()}${pick(MARKERS)}`,
    () => "",
    () => "",
    () => "<!-- note -->",
    () => "<!--",
    () => "-->",
  ];

  const check = (input: string) => {
    const clean = errorCount(input) === 0;
    if (clean) assertStable(input);
    else parseCv(serializeCv(parseCv(input).doc));
    return clean;
  };

  it("is stable on random documents (property test)", () => {
    let clean = 0;
    for (let n = 0; n < 2000; n++) {
      const rows: string[] = [];
      const length = 1 + Math.floor(random() * 10);
      for (let i = 0; i < length; i++) rows.push(pick(LINES)());
      if (check(rows.join("\n"))) clean++;
    }
    assert.ok(clean > 400, `only ${clean} error-free samples`);
  });

  it("is stable on random token soup (property test)", () => {
    const tokens = [...INLINE, "\n", "\n", "\n\n", "\n  ", "- ", "* ", "# ", "## ", "### ", "> "];
    tokens.push("1. ", " <!-- ev: ACH-001 -->", "<!-- note -->", "<!--", "---", "=", "  ");
    let clean = 0;
    for (let n = 0; n < 2000; n++) {
      let input = "";
      const length = 1 + Math.floor(random() * 40);
      for (let i = 0; i < length; i++) input += pick(tokens);
      if (check(input)) clean++;
    }
    assert.ok(clean > 100, `only ${clean} error-free samples`);
  });
});
