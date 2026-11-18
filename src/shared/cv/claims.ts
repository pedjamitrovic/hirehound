import type { CvDoc, Inline } from "./types.ts";

export type ClaimKind = "entry" | "paragraph" | "bullet";

/** One statement a CV makes: an entry heading, a paragraph or a bullet. */
export type Claim = {
  /** Position among the CV's claims, in document order (0-based). */
  n: number;
  kind: ClaimKind;
  /** Plain text: formatting dropped, links reduced to their text. */
  text: string;
  /** Evidence ids from the marker, in the order written. */
  ev: string[];
  /** 1-based line in the file, frontmatter included. */
  line: number;
  /** Plain text of the `##` section it sits in; "" before the first section. */
  section: string;
};

/** Inline nodes as plain text. Links contribute their text only, never the URL. */
export function inlinePlain(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) out += node.t === "text" ? node.v : inlinePlain(node.c);
  return out;
}

/** Every claim in the CV, in document order. Section headings and comments are not claims. */
export function cvClaims(doc: CvDoc): Claim[] {
  const claims: Claim[] = [];
  let section = "";
  const push = (kind: ClaimKind, text: readonly Inline[], ev: string[], line: number) => {
    claims.push({
      n: claims.length,
      kind,
      text: inlinePlain(text).replace(/\s+/g, " ").trim(),
      ev,
      line,
      section,
    });
  };
  for (const block of doc.blocks) {
    if (block.t === "section") section = inlinePlain(block.text).trim();
    else if (block.t === "entry") push("entry", block.text, block.ev, block.line);
    else if (block.t === "paragraph") push("paragraph", block.text, block.ev, block.line);
    else if (block.t === "list") {
      for (const item of block.items) push("bullet", item.text, item.ev, item.line);
    }
  }
  return claims;
}

/** Comparison form of a claim's text: case and spacing do not count as a change. */
export function normalizeClaimText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
