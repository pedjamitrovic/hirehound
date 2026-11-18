// Turns a file uploaded during onboarding into something the AI can read: text for Markdown,
// plain text, Word and LinkedIn exports, or the PDF itself (the AI reads PDFs natively).
import { normalizeText } from "../../shared/frontmatter.ts";
import { docxToText } from "./docx.ts";
import { ImportError } from "./errors.ts";
import { isLinkedInExport, linkedInToText } from "./linkedin.ts";
import { listZip } from "./zip.ts";

export type ImportedSource =
  | { name: string; kind: "text"; origin: "md" | "txt" | "docx" | "linkedin"; text: string }
  | { name: string; kind: "pdf"; data: Uint8Array };

/** Per-file limit for text, Markdown and Word files. */
export const MAX_SOURCE_BYTES = 10_000_000;
/** PDFs with images and LinkedIn exports with message history are bigger. */
export const MAX_PDF_BYTES = 25_000_000;
export const MAX_ZIP_BYTES = 25_000_000;

type Format = "md" | "txt" | "docx" | "zip" | "pdf";

const FORMATS: Record<string, Format> = {
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
  ".docx": "docx",
  ".zip": "zip",
  ".pdf": "pdf",
};

const SUPPORTED =
  "PDF, Word (.docx), Markdown (.md), plain text (.txt) or a LinkedIn data export (.zip)";

function baseName(fileName: string): string {
  return fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function formatOf(name: string): Format | undefined {
  return FORMATS[extensionOf(name)];
}

/** The size limit for a file name, so an upload can be refused before it is read. */
export function maxSourceBytes(fileName: string): number {
  const format = formatOf(baseName(fileName));
  if (format === "pdf") return MAX_PDF_BYTES;
  if (format === "zip") return MAX_ZIP_BYTES;
  return MAX_SOURCE_BYTES;
}

export function extractSource(fileName: string, data: Uint8Array): ImportedSource {
  const name = baseName(fileName);
  const format = formatOf(name);
  if (!format) throw unsupported(extensionOf(name));

  const limit = maxSourceBytes(name);
  if (data.byteLength > limit) {
    throw new ImportError(
      "too-large",
      `This file is larger than ${limit / 1_000_000} MB. Upload a smaller file.`,
    );
  }
  if (data.byteLength === 0) throw new ImportError("empty", "This file is empty.");

  switch (format) {
    case "pdf":
      if (!isPdf(data)) {
        throw new ImportError(
          "corrupt",
          "This file is not a valid PDF. Export it again and retry.",
        );
      }
      return { name, kind: "pdf", data };
    case "md":
    case "txt":
      return textSource(name, format, decodeText(data));
    case "docx":
      return textSource(name, "docx", docxToText(data));
    case "zip": {
      if (!isLinkedInExport(listZip(data))) {
        throw new ImportError(
          "unsupported-type",
          "This ZIP file is not a LinkedIn data export. Upload the export from LinkedIn as is, or your CV files one by one.",
        );
      }
      return textSource(name, "linkedin", linkedInToText(data));
    }
  }
}

function textSource(
  name: string,
  origin: "md" | "txt" | "docx" | "linkedin",
  text: string,
): ImportedSource {
  if (text.trim() === "") throw new ImportError("empty", "Hirehound found no text in this file.");
  return { name, kind: "text", origin, text };
}

function unsupported(extension: string): ImportError {
  if (extension === ".doc") {
    return new ImportError(
      "unsupported-type",
      "Old Word .doc files are not supported. Save it as .docx or PDF and upload that.",
    );
  }
  const what = extension ? `${extension} files` : "files without an extension";
  return new ImportError("unsupported-type", `Hirehound cannot read ${what}. Use ${SUPPORTED}.`);
}

/** PDF readers accept the header anywhere in the first 1024 bytes. */
function isPdf(data: Uint8Array): boolean {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 1024));
  return head.includes("%PDF-", 0, "latin1");
}

/**
 * UTF-8 (with or without BOM) or UTF-16 with BOM; anything else is decoded as Windows-1252,
 * which is what older Windows editors write, rather than failing.
 */
function decodeText(data: Uint8Array): string {
  let text: string;
  if (data[0] === 0xff && data[1] === 0xfe) text = new TextDecoder("utf-16le").decode(data);
  else if (data[0] === 0xfe && data[1] === 0xff) text = new TextDecoder("utf-16be").decode(data);
  else if (data.includes(0)) {
    throw new ImportError("corrupt", "This file does not look like plain text.");
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      text = new TextDecoder("windows-1252").decode(data);
    }
  }
  return normalizeText(text);
}
