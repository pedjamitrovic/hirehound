// A deliberately small HTML-to-readable-text converter for job postings. It keeps the structure
// a reader needs (headings, paragraphs, bullets) and drops everything else. No dependencies.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hyphen: "-",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  deg: "\u00b0",
  times: "\u00d7",
  rarr: "\u2192",
  larr: "\u2190",
  zwj: "",
  zwnj: "",
  shy: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      return code === 160 ? " " : String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

/** Elements whose content is never posting text. */
const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "select",
  "button",
  "form",
  "nav",
  "footer",
  "aside",
  "dialog",
  "head",
]);

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "ul",
  "ol",
  "table",
  "tr",
  "blockquote",
  "pre",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "body",
  "html",
]);

/** Inline formatting that can split a word ("<b>Re</b>quired"), so it adds no space. */
const INLINE = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "em",
  "font",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "mark",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

const HEADING = /^h[1-6]$/;

type Block = { kind: "p" | "li" | "h"; text: string };

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</gi;

/**
 * Converts HTML to Markdown-ish text: "## " headings, "- " bullets, blank lines between blocks.
 * Text inside SKIP elements is dropped. Robust to broken markup (it never throws).
 */
export function htmlToText(html: string): string {
  const blocks: Block[] = [];
  let current: Block = { kind: "p", text: "" };
  let skipDepth = 0;
  let skipTag = "";

  const flush = (next: Block["kind"] = "p") => {
    const text = current.text.replace(/\s+/g, " ").trim();
    if (text) blocks.push({ kind: current.kind, text });
    current = { kind: next, text: "" };
  };

  for (const match of html.matchAll(TOKEN)) {
    const [whole, closing, rawTag, , text] = match;
    if (text !== undefined) {
      if (skipDepth === 0) current.text += decodeEntities(text);
      continue;
    }
    if (rawTag === undefined) {
      if (whole === "<" && skipDepth === 0) current.text += "<";
      continue;
    }
    const tag = rawTag.toLowerCase();

    if (skipDepth > 0) {
      if (tag === skipTag) skipDepth += closing ? -1 : whole.endsWith("/>") ? 0 : 1;
      continue;
    }
    if (SKIP.has(tag) && !closing) {
      if (!whole.endsWith("/>") && !VOID.has(tag)) {
        skipTag = tag;
        skipDepth = 1;
      }
      continue;
    }

    if (tag === "br") {
      flush(current.kind === "li" ? "p" : current.kind);
    } else if (tag === "li") {
      flush(closing ? "p" : "li");
    } else if (HEADING.test(tag)) {
      flush(closing ? "p" : "h");
    } else if (BLOCK.has(tag) || tag === "hr") {
      // A block boundary inside a list item ends the item's first line, not the item.
      flush(current.kind === "li" && !closing && current.text.trim() === "" ? "li" : "p");
    } else if (!INLINE.has(tag)) {
      // Table cells, custom elements and the like: keep words from running together.
      current.text += " ";
    }
  }
  flush();

  const out: string[] = [];
  let previous: Block["kind"] | null = null;
  for (const block of blocks) {
    if (previous !== null) out.push(block.kind === "li" && previous === "li" ? "\n" : "\n\n");
    out.push(
      block.kind === "li"
        ? `- ${block.text}`
        : block.kind === "h"
          ? `## ${block.text}`
          : block.text,
    );
    previous = block.kind;
  }
  return out.join("").trim();
}

/** Picks the part of the page most likely to hold the posting: <main>, then <article>, then <body>. */
export function mainContent(html: string): string {
  for (const tag of ["main", "article", "body"]) {
    const open = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(html);
    if (!open) continue;
    const start = open.index + open[0].length;
    const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
    return html.slice(start, end > start ? end : undefined);
  }
  return html;
}
