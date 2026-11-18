import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCvHtml } from "../../shared/cv/render.ts";
import type { CvDoc } from "../../shared/cv/types.ts";
import type { Contact } from "../../shared/schemas/contact.ts";
import type { CvTheme } from "../../shared/schemas/cv.ts";
import { isNotFound } from "../workspace/fsx.ts";

export type Paper = "a4" | "letter";

const ASSETS = new URL("./", import.meta.url);

/**
 * Static Inter cuts from @fontsource/inter (SIL OFL 1.1). Static fonts matter: Chrome embeds a
 * variable font as Type3 glyphs, which some applicant tracking systems read poorly. Weights the
 * themes ask for that are not listed (650) resolve to the nearest cut.
 */
const FONT_CUTS = ["400", "500", "600", "700", "400-italic", "700-italic"] as const;

let fontCss: Promise<string> | null = null;

/** @font-face rules with the font files inlined, so rendering needs no file or network access. */
function fontFaces(): Promise<string> {
  fontCss ??= (async () => {
    const rules: string[] = [];
    for (const cut of FONT_CUTS) {
      const cssUrl = new URL(import.meta.resolve(`@fontsource/inter/${cut}.css`));
      const css = await readFile(cssUrl, "utf8");
      for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
        const file = /url\(\.\/files\/([\w.-]+\.woff2)\)/.exec(block)?.[1];
        if (!file) continue;
        const data = (await readFile(new URL(`files/${file}`, cssUrl))).toString("base64");
        rules.push(
          block
            .replace(/src:[^;]*;/, `src: url(data:font/woff2;base64,${data}) format("woff2");`)
            .replace(/font-display:\s*\w+;/, "font-display: block;"),
        );
      }
    }
    return rules.join("\n");
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

export type LetterDocumentInput = CvDocumentInput & {
  greeting: string;
  closing: string;
  company: string;
  /** Already formatted for the letter, e.g. "18 November 2026". */
  date: string;
};

/** A cover letter with the same header and theme as the CV. */
export async function letterDocumentHtml(input: LetterDocumentInput): Promise<string> {
  const name = input.contact?.name ?? "";
  const body = [
    `<p class="letter-date">${escapeHtml(input.date)}</p>`,
    `<p class="letter-to">${escapeHtml(input.company)}</p>`,
    `<p class="letter-greeting">${escapeHtml(input.greeting)}</p>`,
    renderCvHtml(input.doc),
    `<p class="letter-closing">${escapeHtml(input.closing)}<br>${escapeHtml(name)}</p>`,
  ].join("\n");
  return (await cvDocumentHtml(input)).replace(
    /<main>[\s\S]*<\/main>/,
    () => `<main class="letter">\n${body}\n</main>`,
  );
}

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
.letter p { margin: 0 0 10pt; }
.letter .cv-section { margin: 0; padding: 0; border: 0; }
.letter-date { margin-top: 6pt; }
.letter-to { margin-bottom: 14pt; }
.letter-closing { margin-top: 14pt; }
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
