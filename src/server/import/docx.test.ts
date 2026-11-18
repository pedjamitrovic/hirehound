import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeZip } from "../../../test/zip-writer.ts";
import { docxToText } from "./docx.ts";
import { ImportError, type ImportErrorCode } from "./errors.ts";

function importError(code: ImportErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ImportError, `expected an ImportError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(" ");

/** A minimal .docx: just enough package around a document body. */
function docx(body: string): Buffer {
  return makeZip([
    { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${NAMESPACES}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
  ]);
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (text: string, props = "") =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${run(text)}</w:p>`;
const style = (id: string) => `<w:pStyle w:val="${id}"/>`;
const numbered = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>';
const cell = (...paragraphs: string[]) =>
  `<w:tc><w:tcPr/>${paragraphs.map((p) => para(p)).join("")}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;

describe("docxToText", () => {
  it("writes one paragraph per w:p with a blank line between them", () => {
    const body = [
      `<w:p><w:r><w:t>Alex </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Example</w:t></w:r></w:p>`,
      para("  Platform    engineer  "),
      "<w:p/>",
      "<w:p><w:pPr/></w:p>",
      para("Berlin"),
    ].join("");
    assert.equal(docxToText(docx(body)), "Alex Example\n\nPlatform engineer\n\nBerlin");
  });

  it("marks titles and headings with ##", () => {
    const body = [
      para("Alex Example", style("Title")),
      para("Experience", style("Heading1")),
      para("Acme Robotics", style("heading3")),
      para("Skills", style("Heading 2")),
      para("Not a heading", style("Subtitle")),
    ].join("");
    assert.equal(
      docxToText(docx(body)),
      "## Alex Example\n\n## Experience\n\n## Acme Robotics\n\n## Skills\n\nNot a heading",
    );
  });

  it("writes numbered paragraphs as a tight bullet list", () => {
    const body = [
      para("Highlights"),
      para("Led a team of 8", numbered),
      para("Cut build times by 40%", `${style("ListParagraph")}${numbered}`),
      para("Styled bullet", style("ListBullet")),
      para("Numbering switched off", '<w:numPr><w:numId w:val="0"/></w:numPr>'),
    ].join("");
    assert.equal(
      docxToText(docx(body)),
      [
        "Highlights",
        "",
        "- Led a team of 8",
        "- Cut build times by 40%",
        "- Styled bullet",
        "",
        "Numbering switched off",
      ].join("\n"),
    );
  });

  it("writes table rows as cells joined with pipes", () => {
    const table = `<w:tbl><w:tblPr/><w:tblGrid/>${[
      row(cell("Language"), cell("Level")),
      row(cell("German"), cell("Native")),
      row(cell(""), cell("")),
      row(cell("2019 - 2021"), cell("Acme Robotics", "Built the fleet API")),
    ].join("")}</w:tbl>`;
    assert.equal(
      docxToText(docx(`${para("Before")}${table}${para("After")}`)),
      [
        "Before",
        "",
        "Language | Level",
        "German | Native",
        "2019 - 2021 | Acme Robotics / Built the fleet API",
        "",
        "After",
      ].join("\n"),
    );
  });

  it("turns tabs into spaces and breaks into new lines, ignoring tab stops", () => {
    const body =
      '<w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>' +
      "<w:r><w:t>Acme</w:t><w:tab/><w:t>2019</w:t><w:br/><w:t>Berlin</w:t></w:r></w:p>";
    assert.equal(docxToText(docx(body)), "Acme 2019\nBerlin");
  });

  it("ignores deleted text, moved-away text and field codes", () => {
    const body =
      "<w:p>" +
      run("Managed ") +
      '<w:del w:id="1" w:author="A"><w:r><w:delText>four</w:delText></w:r></w:del>' +
      '<w:ins w:id="2" w:author="A">' +
      run("six") +
      "</w:ins>" +
      run(" engineers") +
      '<w:moveFrom w:id="3" w:author="A"><w:r><w:t> (moved)</w:t></w:r></w:moveFrom>' +
      "</w:p>" +
      "<w:p>" +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com" </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      run("example.com") +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      "</w:p>";
    assert.equal(docxToText(docx(body)), "Managed six engineers\n\nexample.com");
  });

  it("ignores tracked formatting changes", () => {
    const props = `${style("Normal")}<w:pPrChange w:id="4"><w:pPr>${style("Heading1")}${numbered}</w:pPr></w:pPrChange>`;
    assert.equal(docxToText(docx(para("Plain now", props))), "Plain now");
  });

  it("keeps text box content once", () => {
    const textbox = (text: string) => `<w:txbxContent>${para(text)}</w:txbxContent>`;
    const body =
      "<w:p><w:r><mc:AlternateContent>" +
      `<mc:Choice Requires="wps"><w:drawing>${textbox("Boxed")}</w:drawing></mc:Choice>` +
      `<mc:Fallback><w:pict>${textbox("Boxed")}</w:pict></mc:Fallback>` +
      "</mc:AlternateContent></w:r></w:p>";
    assert.equal(docxToText(docx(body)), "Boxed");
  });

  it("decodes XML entities", () => {
    const body = para("R&amp;D &lt;team&gt; &quot;core&quot; &apos;24 caf&#233; &#x2192; &amp;lt;");
    assert.equal(docxToText(docx(body)), 'R&D <team> "core" \'24 caf\u00e9 \u2192 &lt;');
  });

  it("keeps non-ASCII text as is", () => {
    assert.equal(
      docxToText(docx(para("Z\u00fcrich, 2019 \u2013 2021"))),
      "Z\u00fcrich, 2019 \u2013 2021",
    );
  });

  it("returns an empty string for a document without text", () => {
    assert.equal(docxToText(docx("<w:p/><w:p><w:r><w:t> </w:t></w:r></w:p>")), "");
  });

  it("refuses packages without word/document.xml", () => {
    const zip = makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }]);
    assert.throws(() => docxToText(zip), importError("corrupt"));
  });

  it("refuses files that are not ZIP packages", () => {
    assert.throws(() => docxToText(Buffer.from("plain text, renamed")), importError("corrupt"));
  });

  it("recognises legacy .doc files and password-protected .docx files", () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const legacy = Buffer.concat([ole, Buffer.alloc(512), Buffer.from("WordDocument", "utf16le")]);
    assert.throws(() => docxToText(legacy), importError("unsupported-type"));
    const encrypted = Buffer.concat([
      ole,
      Buffer.alloc(512),
      Buffer.from("EncryptionInfo", "utf16le"),
      Buffer.from("EncryptedPackage", "utf16le"),
    ]);
    assert.throws(() => docxToText(encrypted), importError("encrypted"));
  });
});
