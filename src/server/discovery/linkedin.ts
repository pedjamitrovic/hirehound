import { htmlToText } from "../jobs/html-text.ts";

/** A job card from a LinkedIn job-alert email. */
export type AlertJob = {
  /** LinkedIn's job id, from the "jobs/view/<id>" link. */
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
};

const JOB_LINK =
  /https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/\s"'<>?]*-)?(\d{6,})/i;

/** Lines in an alert that are not part of a job's title, company or location. */
const NOISE =
  /^(view job|apply|easy apply|actively recruiting|promoted|be an early applicant|new|\d+\s+(school alum|alumni|connections?|applicants?)\b|.*\b(applicants?|connections?)$|-{3,}|={3,}|_{3,})/i;

// ---------- MIME ----------

function decodeQuotedPrintable(text: string): string {
  const bytes: number[] = [];
  const soft = text.replace(/=\r?\n/g, "");
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i] as string;
    const hex = soft.slice(i + 1, i + 3);
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

type Part = { type: string; body: string };

function parseHeaders(head: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

function decodePart(headers: Map<string, string>, body: string): string {
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  if (encoding === "base64")
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

/** The text/plain and text/html parts of an email (or the whole input, if it has no headers). */
export function emailParts(raw: string): Part[] {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split > 0 ? text.slice(0, split) : "";
  if (
    !/^(from|to|subject|content-type|mime-version|date|received|return-path|delivered-to):/im.test(
      head,
    )
  ) {
    return [{ type: /<a\b[^>]*href/i.test(text) ? "text/html" : "text/plain", body: text }];
  }
  const parts: Part[] = [];
  const walk = (headers: Map<string, string>, body: string, depth: number) => {
    const type = headers.get("content-type") ?? "text/plain";
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (/^multipart\//i.test(type) && boundary && depth < 5) {
      for (const chunk of body.split(`--${boundary}`).slice(1)) {
        if (chunk.startsWith("--")) break;
        const at = chunk.indexOf("\n\n");
        if (at < 0) continue;
        walk(parseHeaders(chunk.slice(0, at)), chunk.slice(at + 2), depth + 1);
      }
      return;
    }
    const kind = /text\/html/i.test(type)
      ? "text/html"
      : /text\/plain/i.test(type)
        ? "text/plain"
        : "";
    if (kind) parts.push({ type: kind, body: decodePart(headers, body) });
  };
  walk(parseHeaders(head), text.slice(split + 2), 0);
  return parts;
}

// ---------- Job cards ----------

function cleanLine(line: string): string {
  return line
    .replace(/\s+/g, " ")
    .replace(/^[-*\u2022]\s*/, "")
    .trim();
}

/** Job cards from the plain-text part: title, company and location lines above each job link. */
export function alertJobsFromText(text: string): AlertJob[] {
  const lines = text.split("\n");
  const jobs = new Map<string, AlertJob>();
  let block: string[] = [];
  for (const raw of lines) {
    const link = JOB_LINK.exec(raw);
    if (link?.[1]) {
      const id = link[1];
      const fields = block
        .map(cleanLine)
        .filter((l) => l && !NOISE.test(l) && !/https?:\/\//.test(l));
      const [title, company, location] = fields.slice(-3).length === 3 ? fields.slice(-3) : fields;
      if (title && !jobs.has(id)) {
        jobs.set(id, {
          id,
          title,
          company: company ?? null,
          location: location ?? null,
          url: `https://www.linkedin.com/jobs/view/${id}/`,
        });
      }
      block = [];
      continue;
    }
    if (!raw.trim() || /^[-=_]{3,}\s*$/.test(raw.trim())) block = [];
    else block.push(raw);
  }
  return [...jobs.values()];
}

/** Job cards from the HTML part: the link text is the title, the text after it company and place. */
export function alertJobsFromHtml(html: string): AlertJob[] {
  const anchors = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const jobs = new Map<string, AlertJob>();
  for (const [i, match] of anchors.entries()) {
    const id = JOB_LINK.exec(match[1] ?? "")?.[1];
    if (!id || jobs.has(id)) continue;
    const title = cleanLine(htmlToText(match[2] ?? ""));
    if (!title || NOISE.test(title)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = anchors.slice(i + 1).find((a) => JOB_LINK.exec(a[1] ?? "")?.[1] !== id);
    const after = html.slice(start, next?.index ?? start + 2000);
    const [company, location] = htmlToText(after)
      .split("\n")
      .flatMap((l) => l.split(/\s+\u00b7\s+/))
      .map(cleanLine)
      .filter((l) => l && !NOISE.test(l));
    jobs.set(id, {
      id,
      title,
      company: company ?? null,
      location: location ?? null,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
    });
  }
  return [...jobs.values()];
}

/** Every job card in a LinkedIn alert email (.eml) or its pasted text. Plain text wins over HTML. */
export function parseLinkedInAlert(raw: string): AlertJob[] {
  const parts = emailParts(raw);
  const plain = parts
    .filter((p) => p.type === "text/plain")
    .flatMap((p) => alertJobsFromText(p.body));
  if (plain.length) return plain;
  return parts.filter((p) => p.type === "text/html").flatMap((p) => alertJobsFromHtml(p.body));
}
