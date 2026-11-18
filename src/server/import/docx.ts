// Word (.docx) to Markdown-ish text. A .docx file is a ZIP archive; the text lives in
// word/document.xml as WordprocessingML. This keeps what a reader needs (paragraphs, headings,
// list items, table rows) and drops formatting. No XML library: a small tokenizer is enough
// for the predictable XML that Word, Google Docs and LibreOffice write.
import { ImportError } from "./errors.ts";
import { listZip, readZipText } from "./zip.ts";

const DOCUMENT = "word/document.xml";

/** Compound File (OLE) magic: legacy .doc files and password-protected .docx files. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function docxToText(data: Uint8Array): string {
  return render(parseDocument(readDocumentXml(data)));
}

function readDocumentXml(data: Uint8Array): string {
  if (OLE_MAGIC.every((byte, i) => data[i] === byte)) {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.includes(Buffer.from("EncryptedPackage", "utf16le"))) {
      throw new ImportError(
        "encrypted",
        "This Word file is password-protected. Save a copy without a password and upload that.",
      );
    }
    throw new ImportError(
      "unsupported-type",
      "This is an old Word .doc file. Open it in Word, save it as .docx or PDF and upload that.",
    );
  }
  try {
    if (!listZip(data).some((entry) => entry.name === DOCUMENT)) {
      throw new ImportError(
        "corrupt",
        "This Word file has no document text. Open it in Word, save it again and retry.",
      );
    }
    return readZipText(data, DOCUMENT);
  } catch (error) {
    if (error instanceof ImportError && error.code === "corrupt") {
      throw new ImportError(
        "corrupt",
        "This Word file could not be read. Open it in Word, save it as .docx and retry.",
      );
    }
    throw error;
  }
}

type BlockKind = "paragraph" | "heading" | "item" | "row";
type Block = { kind: BlockKind; text: string };
type Paragraph = { text: string; style: string; list: boolean };
type Table = { row: string[] | null; cell: string[] | null };

// Comments, CDATA, processing instructions and declarations, tags, then text.
// Groups: 1 CDATA text, 2 closing slash, 3 qualified name, 4 attributes, 5 text.
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;

const VAL = /(?:^|\s)(?:[\w.-]+:)?val\s*=\s*(?:"([^"]*)"|'([^']*)')/;

/**
 * Elements whose content is not document text: deleted and moved-away tracked changes, field
 * codes, previous formatting kept by tracked changes, tab stop definitions, and the fallback
 * copy of text boxes (the same text also appears in the preferred mc:Choice branch).
 */
const SKIPPED = new Set([
  "del",
  "delText",
  "delInstrText",
  "moveFrom",
  "instrText",
  "pPrChange",
  "rPrChange",
  "tabs",
  "Fallback",
]);

const HEADING_STYLE = /^(?:title|heading ?[1-6])$/i;
const LIST_STYLE = /^list ?(?:bullet|number)/i;

function parseDocument(xml: string): Block[] {
  const blocks: Block[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: Table[] = [];
  let inText = false;
  let skip: { name: string; depth: number } | null = null;

  const append = (text: string) => {
    const paragraph = paragraphs.at(-1);
    if (paragraph) paragraph.text += text;
  };

  const emit = (kind: BlockKind, text: string) => {
    const cell = tables.at(-1)?.cell;
    if (cell) cell.push(text);
    else blocks.push({ kind, text });
  };

  for (const match of xml.matchAll(TOKEN)) {
    const [, cdata, slash, qualified, attrs = "", text] = match;
    if (qualified === undefined) {
      if (skip || !inText) continue;
      if (text !== undefined) append(decodeXml(text));
      else if (cdata !== undefined) append(cdata);
      continue;
    }

    const name = qualified.slice(qualified.indexOf(":") + 1);
    const closing = slash === "/";
    const selfClosing = !closing && attrs.trimEnd().endsWith("/");

    if (skip) {
      if (name === skip.name) {
        if (closing) skip.depth--;
        else if (!selfClosing) skip.depth++;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }

    if (closing) {
      switch (name) {
        case "t":
          inText = false;
          break;
        case "p": {
          const paragraph = paragraphs.pop();
          if (paragraph && paragraph.text.trim() !== "") {
            emit(kindOf(paragraph), paragraph.text);
          }
          break;
        }
        case "tc": {
          const table = tables.at(-1);
          if (table?.row && table.cell) {
            table.row.push(table.cell.join(" / ").replaceAll("\n", " / "));
          }
          if (table) table.cell = null;
          break;
        }
        case "tr": {
          const table = tables.at(-1);
          const cells = table?.row?.map((cell) => cell.trim());
          if (table) table.row = null;
          if (!cells?.some((cell) => cell !== "")) break;
          const line = cells.join(" | ");
          // A nested table becomes part of the cell that contains it.
          const parentCell = tables.at(-2)?.cell;
          if (parentCell) parentCell.push(line);
          else blocks.push({ kind: "row", text: line });
          break;
        }
        case "tbl":
          tables.pop();
          break;
      }
      continue;
    }

    if (SKIPPED.has(name)) {
      if (!selfClosing) skip = { name, depth: 1 };
      continue;
    }

    switch (name) {
      case "p":
        if (!selfClosing) paragraphs.push({ text: "", style: "", list: false });
        break;
      case "t":
        inText = !selfClosing;
        break;
      case "tab":
      case "ptab":
        append(" ");
        break;
      case "br":
      case "cr":
        append("\n");
        break;
      case "noBreakHyphen":
        append("-");
        break;
      case "pStyle": {
        const paragraph = paragraphs.at(-1);
        if (paragraph) paragraph.style = attrValue(attrs);
        break;
      }
      case "numPr": {
        const paragraph = paragraphs.at(-1);
        if (paragraph) paragraph.list = true;
        break;
      }
      case "numId": {
        // numId 0 switches off numbering inherited from the paragraph style.
        const paragraph = paragraphs.at(-1);
        if (paragraph && attrValue(attrs) === "0") paragraph.list = false;
        break;
      }
      case "tbl":
        if (!selfClosing) tables.push({ row: null, cell: null });
        break;
      case "tr": {
        const table = tables.at(-1);
        if (table && !selfClosing) table.row = [];
        break;
      }
      case "tc": {
        const table = tables.at(-1);
        if (table && !selfClosing) table.cell = [];
        break;
      }
    }
  }
  return blocks;
}

function kindOf(paragraph: Paragraph): BlockKind {
  if (HEADING_STYLE.test(paragraph.style)) return "heading";
  if (paragraph.list || LIST_STYLE.test(paragraph.style)) return "item";
  return "paragraph";
}

function attrValue(attrs: string): string {
  const match = VAL.exec(attrs);
  return decodeXml(match?.[1] ?? match?.[2] ?? "");
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g,
    (match, hex?: string, decimal?: string, named?: string) => {
      if (named) return XML_ENTITIES[named] ?? match;
      const code = hex ? Number.parseInt(hex, 16) : Number.parseInt(decimal ?? "", 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    },
  );
}

/**
 * Paragraphs and headings are separated by a blank line; consecutive list items and table rows
 * stay on consecutive lines.
 */
function render(blocks: Block[]): string {
  let out = "";
  let previous: BlockKind | null = null;
  for (const block of blocks) {
    if (previous !== null) {
      const tight = block.kind === previous && (block.kind === "item" || block.kind === "row");
      out += tight ? "\n" : "\n\n";
    }
    if (block.kind === "heading") out += `## ${block.text}`;
    else if (block.kind === "item") out += `- ${block.text}`;
    else out += block.text;
    previous = block.kind;
  }
  return tidy(out);
}

/** Collapses runs of spaces, trims lines, keeps at most one blank line in a row. */
function tidy(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t\u00a0]+/g, " ").trim();
    if (line === "" && lines.at(-1) === "") continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}
