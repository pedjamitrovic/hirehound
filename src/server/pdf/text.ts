import { inflateSync } from "node:zlib";

/**
 * Reads the text back out of a PDF, the way an applicant tracking system would, so the review can
 * show that the CV survives the round trip. Written for the PDFs Chrome produces (Skia): plain or
 * Flate-compressed objects, fonts with ToUnicode maps, text shown with Tj/TJ. It is a check, not a
 * general PDF parser: anything it does not understand simply yields no text.
 */

type PdfObject = { dict: string; stream: Buffer | null };

function inflate(data: Buffer): Buffer | null {
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}

function readObjects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const start = /(\d+)\s+\d+\s+obj\b/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    const num = Number(m[1]);
    const from = m.index + m[0].length;
    const end = text.indexOf("endobj", from);
    if (end < 0) break;
    const streamAt = text.indexOf("stream", from);
    if (streamAt >= 0 && streamAt < end) {
      const dict = text.slice(from, streamAt);
      let dataStart = streamAt + "stream".length;
      if (text[dataStart] === "\r") dataStart++;
      if (text[dataStart] === "\n") dataStart++;
      const length = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
      const dataEnd = length ? dataStart + Number(length[1]) : text.indexOf("endstream", dataStart);
      const raw = pdf.subarray(dataStart, Math.max(dataStart, dataEnd));
      const stream = /\/FlateDecode/.test(dict) ? inflate(raw) : raw;
      objects.set(num, { dict, stream });
      start.lastIndex = Math.max(text.indexOf("endobj", dataEnd), from);
    } else {
      objects.set(num, { dict: text.slice(from, end), stream: null });
      start.lastIndex = end;
    }
  }
  return objects;
}

// ---------- ToUnicode maps ----------

type CMap = { bytes: number; map: Map<number, string> };

function utf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4)
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

export function parseCMap(text: string): CMap {
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  const bytes = space?.[1] ? Math.max(1, space[1].length / 2) : 2;
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? "").matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1] ?? "0", 16), utf16(m[2] ?? ""));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? "";
    for (const m of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g,
    )) {
      const lo = parseInt(m[1] ?? "0", 16);
      const hi = parseInt(m[2] ?? "0", 16);
      if (hi < lo || hi - lo > 65_535) continue;
      if (m[3] !== undefined) {
        const base = utf16(m[3]);
        const head = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1);
        for (let code = lo; code <= hi; code++)
          map.set(code, head + String.fromCharCode(last + code - lo));
      } else {
        const items = [...(m[4] ?? "").matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1] ?? ""));
        items.forEach((value, i) => {
          map.set(lo + i, value);
        });
      }
    }
  }
  return { bytes, map };
}

// ---------- Content streams ----------

type Operand = number | string | Uint8Array | Operand[];

const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isSpace = (ch: string) =>
  ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0";

/** Splits a content stream into operands and operators, calling `onOperator` for each operator. */
function runContent(s: string, onOperator: (op: string, operands: Operand[]) => void): void {
  const stack: Operand[][] = [[]];
  const current = () => stack[stack.length - 1] as Operand[];
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (isSpace(ch)) {
      i++;
    } else if (ch === "%") {
      while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (ch === "(") {
      // Literal string with escapes and balanced parentheses.
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < s.length && depth > 0) {
        const c = s[i] as string;
        if (c === "\\") {
          const next = s[i + 1] ?? "";
          const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0] ?? "0";
            bytes.push(parseInt(oct, 8) & 255);
            i += 1 + oct.length;
            continue;
          }
          if (next === "\r" || next === "\n") {
            i += next === "\r" && s[i + 2] === "\n" ? 3 : 2;
            continue;
          }
          bytes.push(escapes[next] ?? next.charCodeAt(0));
          i += 2;
          continue;
        }
        if (c === "(") depth++;
        if (c === ")" && --depth === 0) break;
        bytes.push(c.charCodeAt(0) & 255);
        i++;
      }
      i++;
      current().push(Uint8Array.from(bytes));
    } else if (ch === "<" && s[i + 1] === "<") {
      i += 2;
    } else if (ch === ">" && s[i + 1] === ">") {
      i += 2;
    } else if (ch === "<") {
      const end = s.indexOf(">", i);
      const hex = s.slice(i + 1, end < 0 ? s.length : end).replace(/\s+/g, "");
      const padded = hex.length % 2 ? `${hex}0` : hex;
      current().push(Uint8Array.from(Buffer.from(padded, "hex")));
      i = end < 0 ? s.length : end + 1;
    } else if (ch === "[") {
      stack.push([]);
      i++;
    } else if (ch === "]") {
      const array = stack.length > 1 ? (stack.pop() as Operand[]) : [];
      current().push(array);
      i++;
    } else if (ch === "/") {
      let j = i + 1;
      while (j < s.length && !isSpace(s[j] as string) && !DELIMITERS.has(s[j] as string)) j++;
      current().push(s.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < s.length && !isSpace(s[j] as string) && !DELIMITERS.has(s[j] as string)) j++;
      if (j === i) {
        i++;
        continue;
      }
      const word = s.slice(i, j);
      i = j;
      const n = Number(word);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) && Number.isFinite(n)) {
        current().push(n);
      } else if (word === "BI") {
        // Inline image data is binary; skip to its end.
        const end = s.indexOf("EI", i);
        i = end < 0 ? s.length : end + 2;
        stack.splice(0, stack.length, []);
      } else {
        onOperator(word, current().splice(0));
        if (stack.length > 1) stack.splice(1);
      }
    }
  }
}

function resolve(objects: Map<number, PdfObject>, value: string): string {
  const ref = /^\s*(\d+)\s+\d+\s+R/.exec(value);
  return ref ? (objects.get(Number(ref[1]))?.dict ?? "") : value;
}

/** Font resource name -> ToUnicode map, for one page's resources. */
function pageFonts(objects: Map<number, PdfObject>, pageDict: string, cmaps: Map<number, CMap>) {
  const fonts = new Map<string, CMap | null>();
  const resourcesAt = pageDict.indexOf("/Resources");
  if (resourcesAt < 0) return fonts;
  const resources = resolve(objects, pageDict.slice(resourcesAt + "/Resources".length));
  const fontAt = resources.indexOf("/Font");
  if (fontAt < 0) return fonts;
  const after = resources.slice(fontAt + "/Font".length);
  const dict = /^\s*<<([\s\S]*?)>>/.exec(after)?.[1] ?? resolve(objects, after);
  for (const m of dict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    fonts.set(`/${m[1]}`, cmaps.get(Number(m[2])) ?? null);
  }
  return fonts;
}

function decode(bytes: Uint8Array, cmap: CMap | null | undefined): string {
  if (!cmap) return Buffer.from(bytes).toString("latin1");
  let out = "";
  for (let i = 0; i + cmap.bytes <= bytes.length; i += cmap.bytes) {
    let code = 0;
    for (let k = 0; k < cmap.bytes; k++) code = code * 256 + (bytes[i + k] ?? 0);
    out += cmap.map.get(code) ?? "";
  }
  return out;
}

/** All text in the PDF, page by page, with a line break wherever the text position jumps. */
export function extractPdfText(pdf: Uint8Array): string {
  const objects = readObjects(Buffer.from(pdf));
  const cmaps = new Map<number, CMap>();
  for (const [num, obj] of objects) {
    if (!/\/Type\s*\/Font\b/.test(obj.dict)) continue;
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict);
    const stream = ref ? objects.get(Number(ref[1]))?.stream : null;
    if (stream) cmaps.set(num, parseCMap(stream.toString("latin1")));
  }

  const pages: string[] = [];
  for (const obj of objects.values()) {
    if (!/\/Type\s*\/Page(?![s\w])/.test(obj.dict)) continue;
    const fonts = pageFonts(objects, obj.dict, cmaps);
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(obj.dict)?.[1] ?? "";
    let text = "";
    for (const ref of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const stream = objects.get(Number(ref[1]))?.stream;
      if (!stream) continue;
      let font: CMap | null | undefined;
      const show = (value: Operand | undefined) => {
        if (value instanceof Uint8Array) text += decode(value, font);
      };
      runContent(stream.toString("latin1"), (op, operands) => {
        switch (op) {
          case "Tf":
            font = typeof operands[0] === "string" ? fonts.get(operands[0]) : undefined;
            break;
          case "Tj":
            show(operands[0]);
            break;
          case "'":
          case '"':
            text += "\n";
            show(operands[operands.length - 1]);
            break;
          case "TJ":
            for (const part of Array.isArray(operands[0]) ? operands[0] : []) {
              if (typeof part === "number") {
                if (part < -200) text += " ";
              } else show(part);
            }
            break;
          case "Td":
          case "TD":
            if (operands[1] !== 0) text += "\n";
            break;
          case "BT":
          case "ET":
          case "Tm":
          case "T*":
            text += "\n";
            break;
        }
      });
    }
    pages.push(
      text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .trim(),
    );
  }
  return pages.join("\n\f\n");
}

/** How many fonts of each subtype the PDF embeds ("Type0", "TrueType", "Type3", ...). */
export function pdfFontTypes(pdf: Uint8Array): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const obj of readObjects(Buffer.from(pdf)).values()) {
    if (!/\/Type\s*\/Font\b/.test(obj.dict)) continue;
    const subtype = /\/Subtype\s*\/(\w+)/.exec(obj.dict)?.[1];
    if (subtype) counts[subtype] = (counts[subtype] ?? 0) + 1;
  }
  return counts;
}

/** Lowercased words (letters and digits), with ligatures and full-width forms folded. */
export function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** How much of `expected` comes back out of the PDF text, as a share of its words. */
export function textCoverage(
  expected: string,
  actual: string,
): { coverage: number; missing: string[]; garbled: number } {
  const have = new Map<string, number>();
  for (const word of wordsOf(actual)) have.set(word, (have.get(word) ?? 0) + 1);
  const want = wordsOf(expected);
  let found = 0;
  const missing: string[] = [];
  for (const word of want) {
    const left = have.get(word) ?? 0;
    if (left > 0) {
      have.set(word, left - 1);
      found++;
    } else if (missing.length < 8 && !missing.includes(word)) missing.push(word);
  }
  // Private-use code points and replacement characters: glyphs an ATS cannot turn into text.
  const garbled = (actual.match(/[\ue000-\uf8ff\ufffd]/g) ?? []).length;
  return { coverage: want.length ? found / want.length : 1, missing, garbled };
}
