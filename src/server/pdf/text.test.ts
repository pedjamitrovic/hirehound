import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { parseCv } from "../../shared/cv/parse.ts";
import { cvPlainText } from "../../shared/cv/render.ts";
import { cvDocumentHtml, themeCss } from "./document.ts";
import { PdfError, PdfRenderer } from "./render.ts";
import { extractPdfText, parseCMap, pdfFontTypes, textCoverage, wordsOf } from "./text.ts";

describe("parseCMap", () => {
  it("reads one-byte and two-byte maps, ranges and arrays", () => {
    const one = parseCMap(
      "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n2 beginbfchar\n<02> <0041>\n<5F> <0045>\nendbfchar",
    );
    assert.equal(one.bytes, 1);
    assert.equal(one.map.get(2), "A");
    assert.equal(one.map.get(0x5f), "E");

    const two = parseCMap(
      [
        "begincodespacerange <0000> <FFFF> endcodespacerange",
        "beginbfrange",
        "<0010> <0012> <0061>",
        "<0020> <0021> [<0066006C> <0078>]",
        "endbfrange",
      ].join("\n"),
    );
    assert.equal(two.bytes, 2);
    assert.deepEqual(
      [0x10, 0x11, 0x12, 0x20, 0x21].map((code) => two.map.get(code)),
      ["a", "b", "c", "fl", "x"],
    );
  });
});

describe("extractPdfText", () => {
  it("reads text shown with a simple font and escaped literal strings", () => {
    const content =
      "BT /F1 10 Tf 40 800 Td (Grew \\(and kept\\) 14) Tj ET\nBT 40 780 Td [(Cut)-300(latency)] TJ ET";
    const pdf = [
      "%PDF-1.4",
      "1 0 obj << /Type /Page /Resources << /Font << /F1 2 0 R >> >> /Contents 3 0 R >> endobj",
      "2 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
      `3 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
      "%%EOF",
    ].join("\n");
    assert.equal(extractPdfText(Buffer.from(pdf, "latin1")), "Grew (and kept) 14\nCut latency");
  });

  it("ignores what it cannot read instead of failing", () => {
    assert.equal(extractPdfText(Buffer.from("not a pdf")), "");
  });
});

describe("textCoverage", () => {
  it("counts words, folds ligatures and reports garbled characters", () => {
    assert.deepEqual(wordsOf("O\ufb03ce: 40% (p95)"), ["office", "40", "p95"]);
    const result = textCoverage("Grew the team the team", "grew the team\ue088");
    assert.equal(result.coverage, 0.6);
    assert.deepEqual(result.missing, ["the", "team"]);
    assert.equal(result.garbled, 1);
  });
});

describe("Chrome PDF round trip", () => {
  const renderer = new PdfRenderer();
  after(() => renderer.close());

  it("gets every word of a rendered CV back, dates included", async (t) => {
    const cv =
      "## Experience\n\n### Engineering Manager, Acme Robotics | 2021-03 - present\n\n- Grew the office team from 4 to 14 engineers, efficiency up 40%\n";
    const doc = parseCv(cv).doc;
    let pdf: Buffer;
    try {
      ({ pdf } = await renderer.render(
        await cvDocumentHtml({
          doc,
          contact: { version: 1, name: "Alex Example", email: "alex@example.com", links: [] },
          headline: "Engineering Manager",
          css: await themeCss("/nonexistent-workspace", "classic"),
          paper: "a4",
        }),
        "a4",
      ));
    } catch (error) {
      if (error instanceof PdfError && error.code === "no-browser") {
        t.skip(`no Chrome or Edge here: ${error.message}`);
        return;
      }
      throw error;
    }
    const text = extractPdfText(pdf);
    assert.match(text, /2021-03 - present/);
    // Static fonts embed as real fonts; a variable font would come out as Type3 glyphs.
    assert.equal(pdfFontTypes(pdf).Type3, undefined);
    assert.ok((pdfFontTypes(pdf).Type0 ?? 0) > 0);
    const result = textCoverage(`Alex Example\nEngineering Manager\n${cvPlainText(doc)}`, text);
    assert.deepEqual(result, { coverage: 1, missing: [], garbled: 0 });
  });
});
