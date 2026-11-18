import { joinFrontmatter, toYaml } from "../frontmatter.ts";
import { ESCAPABLE, formatMarker, isMarkerLike } from "./syntax.ts";
import type { Block, CvDoc, Inline } from "./types.ts";

/** A `<` before one of these could start raw HTML, an autolink or a comment, so it is escaped. */
const HTML_START = /[A-Za-z0-9/!?]/;

/**
 * Escapes literal text so the parser reads it back unchanged. `*`, `[` and `]` are always
 * escaped; a backslash only where it would otherwise escape what follows (including the next
 * node's delimiter); `<` only where it could start HTML.
 */
function escapeText(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v.charAt(i);
    const next = v.charAt(i + 1);
    if (ch === "*" || ch === "[" || ch === "]") out += `\\${ch}`;
    else if (ch === "\\") out += next === "" || ESCAPABLE.includes(next) ? "\\\\" : "\\";
    else if (ch === "<") out += next !== "" && HTML_START.test(next) ? "\\<" : "<";
    else out += ch;
  }
  return out;
}

function inlines(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text") out += escapeText(node.v);
    else if (node.t === "strong") out += `**${inlines(node.c)}**`;
    else if (node.t === "em") out += `*${inlines(node.c)}*`;
    else out += `[${inlines(node.c)}](${node.href})`;
  }
  return out;
}

/** `prefix text <!-- ev: ... -->` without empty parts or trailing spaces. */
function line(prefix: string, text: readonly Inline[], ev: readonly string[]): string {
  const parts = [prefix, inlines(text), ev.length > 0 ? formatMarker(ev) : ""];
  return parts.filter((part) => part !== "").join(" ");
}

function block(b: Block): string {
  switch (b.t) {
    case "section":
      return line("##", b.text, []);
    case "entry":
      return line("###", b.text, b.ev);
    case "paragraph":
      return line("", b.text, b.ev);
    case "list":
      return b.items.map((item) => line("-", item.text, item.ev)).join("\n");
    case "comment":
      // On one line, a comment that reads like `ev: ...` would be taken for a stray marker.
      if (b.v.includes("\n") || isMarkerLike(b.v)) return `<!--\n${b.v}\n-->`;
      return b.v === "" ? "<!-- -->" : `<!-- ${b.v} -->`;
  }
}

/**
 * Writes the canonical form of a CV: frontmatter only when it has keys, one blank line between
 * blocks, `-` bullets, one line per paragraph, LF line endings and a final newline.
 * `parseCv(serializeCv(doc)).doc` equals `doc` apart from line numbers for every doc that
 * parseCv produces from an error-free file, and `serializeCv(parseCv(x).doc)` is a fixed point.
 * A hand-built AST round-trips too when it looks like one the parser could produce: text without
 * newlines or surrounding whitespace, no paragraph starting with block syntax (`#`, `-`, `>`,
 * `|`, `1.`), no strong inside strong or em inside em, and no em or strong placed right next to
 * another one or at the very start or end of one (asterisks there are ambiguous). YAML comments
 * in the frontmatter are not kept; the AST holds plain values.
 */
export function serializeCv(doc: CvDoc): string {
  const body = doc.blocks
    .map(block)
    .filter((text) => text !== "")
    .join("\n\n");
  if (Object.keys(doc.frontmatter).length === 0) return body === "" ? "" : `${body}\n`;
  if (body === "") return `---\n${toYaml(doc.frontmatter)}---\n`;
  return joinFrontmatter(doc.frontmatter, body);
}
