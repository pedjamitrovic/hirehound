import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCvHtml } from "../../shared/cv/render.ts";
import type { CvDoc } from "../../shared/cv/types.ts";
import type { Contact } from "../../shared/schemas/contact.ts";
import type { CvTheme } from "../../shared/schemas/cv.ts";
import { isNotFound } from "../workspace/fsx.ts";

export type Paper = "a4" | "letter";

const ASSETS = new URL("./", import.meta.url);

let fontCss: Promise<string> | null = null;

/** The bundled Inter fonts, inlined so rendering needs no file or network access. */
function fontFaces(): Promise<string> {
  fontCss ??= (async () => {
    const face = async (file: string, style: string) => {
      const data = (await readFile(new URL(`fonts/${file}`, ASSETS))).toString("base64");
      return `@font-face{font-family:"Inter";font-style:${style};font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2");}`;
    };
    return (
      await Promise.all([
        face("InterVariable.woff2", "normal"),
        face("InterVariable-Italic.woff2", "italic"),
      ])
    ).join("\n");
  })();
  return fontCss;
}

/** Theme CSS: the workspace's templates/<theme>.css overrides the built-in theme. */
export async function themeCss(root: string, theme: CvTheme): Promise<string> {
  try {
    return await readFile(join(root, "templates", `${theme}.css`), "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return readFile(new URL(`themes/${theme}.css`, ASSETS), "utf8");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function contactLine(contact: Contact): string {
  const parts: string[] = [];
  if (contact.location) parts.push(escapeHtml(contact.location));
  parts.push(`<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>`);
  if (contact.phone) parts.push(escapeHtml(contact.phone));
  for (const link of contact.links) {
    const shown = link.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    parts.push(`<a href="${escapeHtml(link.url)}">${escapeHtml(shown)}</a>`);
  }
  return parts.join(" | ");
}

export type CvDocumentInput = {
  doc: CvDoc;
  contact: Contact | null;
  headline?: string | undefined;
  css: string;
  paper: Paper;
};

/** A complete, self-contained HTML document for one CV: used for the preview and the PDF. */
export async function cvDocumentHtml(input: CvDocumentInput): Promise<string> {
  const name = input.contact?.name ?? "Your name (set it in Profile, Contact)";
  const size = input.paper === "letter" ? "Letter" : "A4";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)} CV</title>
<style>
${await fontFaces()}
@page { size: ${size}; margin: 15mm 16mm 15mm 16mm; }
html { color-scheme: light; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media screen { body { padding: 15mm 16mm; } }
${input.css}
/* Contextual alternates swap glyphs (Inter's hyphen between digits) for ones that map to private
   code points, so "2021-03" would come out of the PDF as "2021?03" for an ATS. Keep them off. */
body, body * { font-variant-ligatures: no-contextual; }
</style>
</head>
<body>
<header class="cv-header">
<h1 class="cv-name">${escapeHtml(name)}</h1>
${input.headline ? `<p class="cv-headline">${escapeHtml(input.headline)}</p>` : ""}
${input.contact ? `<p class="cv-contact">${contactLine(input.contact)}</p>` : ""}
</header>
<main>
${renderCvHtml(input.doc)}
</main>
</body>
</html>
`;
}
