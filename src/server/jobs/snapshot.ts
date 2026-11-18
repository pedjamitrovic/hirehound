import { createHash, randomUUID } from "node:crypto";
import { localIsoDateTime } from "../../shared/time.ts";
import { HttpError } from "../http/router.ts";
import { APP_VERSION } from "../version.ts";
import { descriptionToText, type Extracted, extractPosting } from "./extract.ts";
import { htmlToText, mainContent } from "./html-text.ts";

export type Snapshot = {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  html: string;
  text: string;
  extracted: Extracted;
  warnings: string[];
};

const MAX_BYTES = 5_000_000;
const MIN_USEFUL_TEXT = 300;

/** Hash of normalised posting text, used for change and repost detection. */
export function textSha256(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

/** Normalises pasted or extracted text: LF, no trailing spaces, at most one blank line in a row. */
export function normalizePostingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function charsetFrom(contentType: string | null, head: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader;
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  return fromMeta ?? "utf-8";
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  try {
    return new TextDecoder(charsetFrom(contentType, head)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(
        422,
        "too-large",
        "That page is too large to snapshot. Paste the text instead.",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function blockedMessage(url: URL, status: number): string {
  if (url.hostname.endsWith("linkedin.com")) {
    return "LinkedIn only shows postings to signed-in users. Paste the posting text instead.";
  }
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return `The site refused the request (${status}). Some sites block automated access; paste the posting text instead.`;
  }
  if (status === 404 || status === 410) {
    return `The page was not found (${status}). The posting may have been taken down.`;
  }
  return `The site answered with an error (${status}). Try again, or paste the posting text instead.`;
}

export type FetchOptions = { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch };

/**
 * Fetches a posting page and extracts what it can, without writing anything. Hirehound identifies
 * itself honestly and never tries to get around sites that refuse automated access.
 */
export async function fetchPosting(rawUrl: string, options: FetchOptions = {}): Promise<Snapshot> {
  const url = new URL(rawUrl);
  const doFetch = options.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: {
        "user-agent": `Mozilla/5.0 (compatible; Hirehound/${APP_VERSION}; +https://github.com/pedjamitrovic/hirehound)`,
        accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en;q=0.9,*;q=0.5",
      },
    });
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    throw new HttpError(
      422,
      "fetch-failed",
      timedOut
        ? "The site did not answer in time. Try again, or paste the posting text instead."
        : `Could not reach ${url.hostname}. Check the link, or paste the posting text instead.`,
    );
  }
  const finalUrl = new URL(res.url || url.href);
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(422, "fetch-blocked", blockedMessage(finalUrl, res.status));
  }
  const contentType = res.headers.get("content-type");
  if (contentType && !/html|text\/plain|xml/i.test(contentType)) {
    await res.body?.cancel();
    throw new HttpError(
      422,
      "not-html",
      `That link is not a web page (${contentType.split(";")[0]}). Paste the posting text instead.`,
    );
  }

  const html = decode(await readLimited(res, options.maxBytes ?? MAX_BYTES), contentType);
  const extracted = extractPosting(html, finalUrl);
  const fromJsonLd = extracted.description ? descriptionToText(extracted.description) : "";
  const fromPage = htmlToText(mainContent(html));
  const text = normalizePostingText(
    fromJsonLd.length >= MIN_USEFUL_TEXT || fromJsonLd.length >= fromPage.length
      ? fromJsonLd
      : fromPage,
  );

  const warnings: string[] = [];
  if (text.length < MIN_USEFUL_TEXT) {
    warnings.push(
      "Very little text was found. The page probably needs JavaScript to show the posting. Check the text, or paste it instead.",
    );
  }
  if (finalUrl.hostname.endsWith("linkedin.com")) {
    warnings.push(
      "LinkedIn pages often hide the posting from signed-out visitors. Check the text.",
    );
  }
  if (!extracted.company || !extracted.title) {
    warnings.push("Could not detect the company or role. Please fill them in.");
  }

  return {
    url: url.href,
    finalUrl: finalUrl.href,
    fetchedAt: localIsoDateTime(),
    html,
    text,
    extracted,
    warnings,
  };
}

/**
 * Fetched snapshots wait here between "preview" and "add", so the page is fetched once and the
 * raw HTML never round-trips through the browser.
 */
export class SnapshotCache {
  #entries = new Map<string, { snapshot: Snapshot; expires: number }>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(ttlMs = 30 * 60_000, max = 20) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  put(snapshot: Snapshot): string {
    this.#prune();
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    const token = randomUUID();
    this.#entries.set(token, { snapshot, expires: Date.now() + this.#ttlMs });
    return token;
  }

  get(token: string): Snapshot | undefined {
    this.#prune();
    return this.#entries.get(token)?.snapshot;
  }

  delete(token: string): void {
    this.#entries.delete(token);
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.#entries) {
      if (entry.expires < now) this.#entries.delete(token);
    }
  }
}
