import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeZip } from "../../../test/zip-writer.ts";
import { ImportError, type ImportErrorCode } from "./errors.ts";
import {
  extractSource,
  MAX_PDF_BYTES,
  MAX_SOURCE_BYTES,
  MAX_ZIP_BYTES,
  maxSourceBytes,
} from "./extract.ts";

function importError(code: ImportErrorCode, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ImportError, `expected an ImportError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  };
}

const bytes = (text: string) => Buffer.from(text, "utf8");

function docx(text: string): Buffer {
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return makeZip([{ name: "word/document.xml", data: xml }]);
}

const PDF = bytes("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

describe("extractSource", () => {
  it("reads Markdown and plain text, normalising BOM and line endings", () => {
    assert.deepEqual(extractSource("cv.md", bytes("\ufeff# Alex\r\n\r\nEngineer\r\n")), {
      name: "cv.md",
      kind: "text",
      origin: "md",
      text: "# Alex\n\nEngineer\n",
    });
    assert.equal(extractSource("notes.MARKDOWN", bytes("x")).kind, "text");
    const txt = extractSource("C:\\Users\\someone\\notes.txt", bytes("plain"));
    assert.deepEqual(txt, { name: "notes.txt", kind: "text", origin: "txt", text: "plain" });
  });

  it("falls back to Windows-1252 for text that is not UTF-8", () => {
    const latin = Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x6f, 0x6b, 0x94]);
    const source = extractSource("old.txt", latin);
    assert.equal(source.kind === "text" && source.text, "Caf\u00e9 \u201cok\u201d");
  });

  it("reads UTF-16 text with a byte order mark", () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Z\u00fcrich\r\n", "utf16le"),
    ]);
    const le16 = extractSource("cv.txt", le);
    assert.equal(le16.kind === "text" && le16.text, "Z\u00fcrich\n");
    const be = Buffer.from(Buffer.from("Hi", "utf16le")).swap16();
    const be16 = extractSource("cv.txt", Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    assert.equal(be16.kind === "text" && be16.text, "Hi");
  });

  it("refuses binary data named as text", () => {
    const zip = makeZip([{ name: "a.txt", data: "x".repeat(100) }]);
    assert.throws(() => extractSource("cv.txt", zip), importError("corrupt"));
  });

  it("converts Word files", () => {
    assert.deepEqual(extractSource("CV.DOCX", docx("Alex Example")), {
      name: "CV.DOCX",
      kind: "text",
      origin: "docx",
      text: "Alex Example",
    });
  });

  it("converts LinkedIn exports and refuses other ZIP files", () => {
    const linkedin = makeZip([
      { name: "Positions.csv", data: "Company Name,Title\nAcme,Engineer\n" },
    ]);
    const source = extractSource("Basic_LinkedInDataExport.zip", linkedin);
    assert.equal(source.kind === "text" && source.origin, "linkedin");
    assert.match(source.kind === "text" ? source.text : "", /### Engineer at Acme/);

    const other = makeZip([{ name: "cv.docx", data: "x" }]);
    assert.throws(
      () => extractSource("cvs.zip", other),
      importError("unsupported-type", /LinkedIn/),
    );
    assert.throws(() => extractSource("fake.zip", bytes("not a zip")), importError("corrupt"));
  });

  it("returns PDFs unchanged after checking the header", () => {
    const source = extractSource("cv.pdf", PDF);
    assert.equal(source.kind, "pdf");
    assert.equal(source.kind === "pdf" && source.data, PDF);
    const prefixed = Buffer.concat([bytes("junk before the header\n"), PDF]);
    assert.equal(extractSource("cv.pdf", prefixed).kind, "pdf");
    assert.throws(() => extractSource("cv.pdf", bytes("<html>")), importError("corrupt"));
  });

  it("refuses unsupported types with a list of supported ones", () => {
    for (const name of ["cv.pages", "cv.rtf", "cv.odt", "photo.png", "README", ".txt"]) {
      assert.throws(
        () => extractSource(name, bytes("x")),
        importError("unsupported-type", /PDF, Word \(\.docx\), Markdown/),
        name,
      );
    }
    assert.throws(
      () => extractSource("old.doc", bytes("x")),
      importError("unsupported-type", /\.docx/),
    );
  });

  it("enforces size limits per type", () => {
    assert.equal(maxSourceBytes("cv.md"), MAX_SOURCE_BYTES);
    assert.equal(maxSourceBytes("cv.PDF"), MAX_PDF_BYTES);
    assert.equal(maxSourceBytes("export.zip"), MAX_ZIP_BYTES);

    const text = Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61);
    assert.throws(() => extractSource("big.txt", text), importError("too-large", /10 MB/));
    assert.throws(() => extractSource("big.docx", text), importError("too-large"));

    const pdf = Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x20);
    PDF.copy(pdf);
    assert.equal(extractSource("big.pdf", pdf).kind, "pdf");
    const huge = Buffer.alloc(MAX_PDF_BYTES + 1, 0x20);
    PDF.copy(huge);
    assert.throws(() => extractSource("huge.pdf", huge), importError("too-large", /25 MB/));
  });

  it("refuses empty files and files without text", () => {
    assert.throws(() => extractSource("cv.pdf", new Uint8Array()), importError("empty"));
    assert.throws(() => extractSource("cv.md", bytes(" \r\n\t\n")), importError("empty"));
    assert.throws(() => extractSource("cv.docx", docx("   ")), importError("empty"));
    const noCareerData = makeZip([{ name: "Profile.csv", data: "First Name,Last Name\n" }]);
    assert.throws(() => extractSource("export.zip", noCareerData), importError("empty"));
  });
});
