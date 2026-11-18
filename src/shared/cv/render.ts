import { isAllowedHref } from "./syntax.ts";
import type { CvDoc, Inline } from "./types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function inlineHtml(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text") out += escapeHtml(node.v);
    else if (node.t === "strong") out += `<strong>${inlineHtml(node.c)}</strong>`;
    else if (node.t === "em") out += `<em>${inlineHtml(node.c)}</em>`;
    // The parser only builds allowed links; an AST built elsewhere gets no other scheme through.
    else if (!isAllowedHref(node.href)) out += inlineHtml(node.c);
    else {
      const href = escapeHtml(node.href);
      out += `<a href="${href}" rel="noopener noreferrer">${inlineHtml(node.c)}</a>`;
    }
  }
  return out;
}

/**
 * Renders the CV body as an HTML fragment. Each `##` heading opens a
 * `<section class="cv-section">` that runs to the next one; blocks before the first heading go
 * in a `<section class="cv-section cv-intro">` without a heading. Evidence markers and comments
 * are never rendered.
 */
export function renderCvHtml(doc: CvDoc): string {
  const out: string[] = [];
  let open = false;
  const ensureSection = () => {
    if (open) return;
    out.push('<section class="cv-section cv-intro">');
    open = true;
  };
  for (const block of doc.blocks) {
    switch (block.t) {
      case "section":
        if (open) out.push("</section>");
        out.push('<section class="cv-section">', `<h2>${inlineHtml(block.text)}</h2>`);
        open = true;
        break;
      case "entry":
        ensureSection();
        out.push(`<h3 class="cv-entry">${inlineHtml(block.text)}</h3>`);
        break;
      case "paragraph":
        ensureSection();
        out.push(`<p>${inlineHtml(block.text)}</p>`);
        break;
      case "list":
        if (block.items.length === 0) break;
        ensureSection();
        out.push("<ul>");
        for (const item of block.items) out.push(`<li>${inlineHtml(item.text)}</li>`);
        out.push("</ul>");
        break;
      case "comment":
        break;
    }
  }
  if (open) out.push("</section>");
  return out.join("\n");
}

function inlineText(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text") out += node.v;
    else if (node.t !== "link") out += inlineText(node.c);
    else {
      const text = inlineText(node.c);
      const target = node.href.replace(/^mailto:/i, "");
      out += text === node.href || text === target ? text : `${text} (${target})`;
    }
  }
  return out;
}

/**
 * The CV as readable plain text: one paragraph per block, bullets as `- ` lines, links as
 * `text (url)` when the text is not the url itself. No markup, markers or comments.
 */
export function cvPlainText(doc: CvDoc): string {
  const parts: string[] = [];
  for (const block of doc.blocks) {
    if (block.t === "comment") continue;
    if (block.t === "list") {
      if (block.items.length === 0) continue;
      parts.push(block.items.map((item) => `- ${inlineText(item.text)}`).join("\n"));
    } else {
      parts.push(inlineText(block.text));
    }
  }
  return parts.join("\n\n");
}
