// Deterministic metadata extraction from a job posting page, no AI involved. Most ATS pages
// (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday) embed a schema.org JobPosting
// as JSON-LD, which is far more reliable than scraping the visible page.
import type { SalaryRange } from "../../shared/schemas/common.ts";
import type { EmploymentType, Workplace } from "../../shared/schemas/posting.ts";
import { decodeEntities, htmlToText } from "./html-text.ts";

export type Extracted = {
  title: string | null;
  company: string | null;
  location: string | null;
  workplace: Workplace;
  employmentType: EmploymentType;
  salary: SalaryRange | null;
  postedAt: string | null;
  validThrough: string | null;
  /** HTML (or text) description from JSON-LD, when present. */
  description: string | null;
  /** Provider-scoped id for dedupe, e.g. "greenhouse:acme:4012345". */
  sourceRef: string | null;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(value: Json | undefined): string | null {
  if (typeof value === "string") {
    const clean = decodeEntities(value).replace(/\s+/g, " ").trim();
    return clean || null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function parseJsonLd(raw: string): Json | null {
  const text = raw
    .trim()
    .replace(/^<!--|-->$/g, "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "");
  try {
    return JSON.parse(text) as Json;
  } catch {
    try {
      // Raw newlines/tabs inside strings are a common JSON-LD bug; a space is valid anywhere.
      const cleaned = Array.from(text, (ch) => (ch.charCodeAt(0) < 0x20 ? " " : ch)).join("");
      return JSON.parse(cleaned) as Json;
    } catch {
      return null;
    }
  }
}

function hasType(node: JsonObject, type: string): boolean {
  const t = node["@type"];
  return t === type || (Array.isArray(t) && t.includes(type));
}

function findJobPostings(value: Json, found: JsonObject[] = [], depth = 0): JsonObject[] {
  if (depth > 6) return found;
  if (Array.isArray(value)) {
    for (const item of value) findJobPostings(item, found, depth + 1);
  } else if (isObject(value)) {
    if (hasType(value, "JobPosting")) found.push(value);
    const graph = value["@graph"];
    if (graph !== undefined) findJobPostings(graph, found, depth + 1);
  }
  return found;
}

export function jobPostingsFromHtml(html: string): JsonObject[] {
  const found: JsonObject[] = [];
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, body] of scripts) {
    const parsed = body ? parseJsonLd(body) : null;
    if (parsed !== null) findJobPostings(parsed, found);
  }
  return found;
}

function placeName(place: Json | undefined): string | null {
  if (typeof place === "string") return str(place);
  if (!isObject(place)) return null;
  const address = place.address;
  if (typeof address === "string") return str(address);
  if (isObject(address)) {
    const country = isObject(address.addressCountry)
      ? str(address.addressCountry.name)
      : str(address.addressCountry);
    const parts = [str(address.addressLocality), str(address.addressRegion), country].filter(
      (p): p is string => p !== null,
    );
    const unique = parts.filter((p, i) => parts.indexOf(p) === i);
    if (unique.length) return unique.join(", ");
  }
  return str(place.name);
}

function locationOf(posting: JsonObject): string | null {
  const raw = posting.jobLocation;
  const places = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const names = places.map(placeName).filter((n): n is string => n !== null);
  const unique = names.filter((n, i) => names.indexOf(n) === i);
  if (unique.length === 0) {
    const requirements = posting.applicantLocationRequirements;
    const list = Array.isArray(requirements) ? requirements : [requirements];
    const areas = list.map((r) => (isObject(r) ? str(r.name) : str(r))).filter(Boolean);
    return areas.length ? `Remote (${areas.join(", ")})` : null;
  }
  if (unique.length <= 3) return unique.join(" / ");
  return `${unique.slice(0, 3).join(" / ")} +${unique.length - 3} more`;
}

export function workplaceFrom(locationType: string | null, ...texts: (string | null)[]): Workplace {
  if (locationType?.toUpperCase().includes("TELECOMMUTE")) return "remote";
  const text = texts.filter(Boolean).join(" ").toLowerCase();
  if (/\bhybrid\b/.test(text)) return "hybrid";
  if (/\bremote\b/.test(text)) return "remote";
  if (/\bon[- ]?site\b|\bin[- ]office\b/.test(text)) return "onsite";
  return "unknown";
}

const EMPLOYMENT: Record<string, EmploymentType> = {
  FULL_TIME: "full-time",
  PART_TIME: "part-time",
  CONTRACTOR: "contract",
  CONTRACT: "contract",
  TEMPORARY: "contract",
  INTERN: "internship",
  INTERNSHIP: "internship",
};

function employmentOf(value: Json | undefined): EmploymentType {
  const list = Array.isArray(value) ? value : [value];
  for (const item of list) {
    const key = str(item)
      ?.toUpperCase()
      .replace(/[\s-]+/g, "_");
    if (key && EMPLOYMENT[key]) return EMPLOYMENT[key];
  }
  return "unknown";
}

const PERIODS: Record<string, SalaryRange["period"]> = {
  YEAR: "year",
  ANNUAL: "year",
  MONTH: "month",
  DAY: "day",
  HOUR: "hour",
};

function numberOf(value: Json | undefined): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function salaryOf(value: Json | undefined): SalaryRange | null {
  if (!isObject(value)) return null;
  const currency = str(value.currency)?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  const quantity = value.value;
  let min: number | undefined;
  let max: number | undefined;
  let unit = "YEAR";
  if (isObject(quantity)) {
    min = numberOf(quantity.minValue) ?? numberOf(quantity.value);
    max = numberOf(quantity.maxValue) ?? numberOf(quantity.value);
    unit = str(quantity.unitText)?.toUpperCase() ?? unit;
  } else {
    min = max = numberOf(quantity);
  }
  const period = PERIODS[unit];
  if ((min === undefined && max === undefined) || !period) return null;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  const range = min === max || max === undefined ? `${min}` : `${min ?? ""}-${max}`;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    currency,
    period,
    raw: `${currency} ${range} per ${period}`,
  };
}

function dateOf(value: Json | undefined): string | null {
  const text = str(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2})/.exec(text) : null;
  return match?.[1] ?? null;
}

function metaContent(html: string, names: string[]): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = tag[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!key || !names.includes(key)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const value = str(content?.[1] ?? content?.[2] ?? null);
    if (value) return value;
  }
  return null;
}

function documentTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1] ? str(match[1]) : null;
}

type AtsInfo = { provider: string; board: string; id: string | null };

/** Recognises public ATS job URLs; the board slug doubles as a company name fallback. */
export function atsFromUrl(url: URL): AtsInfo | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host.endsWith("greenhouse.io")) {
    const board = parts[0] === "embed" ? url.searchParams.get("for") : parts[0];
    const id = url.searchParams.get("gh_jid") ?? (parts[1] === "jobs" ? (parts[2] ?? null) : null);
    return board ? { provider: "greenhouse", board, id } : null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return parts[0] ? { provider: "lever", board: parts[0], id: parts[1] ?? null } : null;
  }
  if (host === "jobs.ashbyhq.com") {
    return parts[0] ? { provider: "ashby", board: parts[0], id: parts[1] ?? null } : null;
  }
  if (host === "apply.workable.com") {
    const id = parts[1] === "j" ? (parts[2] ?? null) : null;
    return parts[0] ? { provider: "workable", board: parts[0], id } : null;
  }
  if (host === "jobs.smartrecruiters.com") {
    return parts[0] ? { provider: "smartrecruiters", board: parts[0], id: parts[1] ?? null } : null;
  }
  return null;
}

function humanizeSlug(slug: string): string {
  return decodeURIComponent(slug)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Removes "Job Application for", "at Company", "| Company", "Company - " from page titles. */
export function cleanTitle(title: string, company: string | null): string {
  let result = title.replace(/^(job application for|apply for|job:)\s+/i, "").trim();
  if (company) {
    const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(`\\s+(?:at|@)\\s+${escaped}\\s*$`, "i"), "")
      .replace(new RegExp(`\\s*[|\\-:\u2013\u2014]\\s*${escaped}\\s*$`, "i"), "")
      .replace(new RegExp(`^${escaped}\\s*[|\\-:\u2013\u2014]\\s*`, "i"), "");
  }
  // "Senior Engineer | Careers" style suffixes.
  result = result.replace(/\s*[|\u2013\u2014]\s*(careers?|jobs?)( at .*)?$/i, "");
  return result.trim() || title;
}

/** JSON-LD descriptions are HTML, sometimes entity-escaped HTML ("&lt;p&gt;"), sometimes text. */
export function descriptionToText(description: string): string {
  const escaped = /&lt;\/?[a-z]/i.test(description) && !/<\/?[a-z]/i.test(description);
  return htmlToText(escaped ? decodeEntities(description) : description);
}

export function extractPosting(html: string, url: URL): Extracted {
  const ats = atsFromUrl(url);
  const posting = jobPostingsFromHtml(html)[0];

  const ldCompany = posting
    ? isObject(posting.hiringOrganization)
      ? str(posting.hiringOrganization.name)
      : str(posting.hiringOrganization)
    : null;
  const siteName = metaContent(html, ["og:site_name"]);
  const company = ldCompany ?? siteName ?? (ats ? humanizeSlug(ats.board) : null);

  const rawTitle =
    str(posting?.title) ?? metaContent(html, ["og:title", "twitter:title"]) ?? documentTitle(html);
  const title = rawTitle ? cleanTitle(rawTitle, company) : null;

  const location = posting ? locationOf(posting) : null;
  const description = typeof posting?.description === "string" ? posting.description : null;
  const descriptionText = description ? descriptionToText(description) : "";
  const workplace = workplaceFrom(
    posting ? str(posting.jobLocationType) : null,
    location,
    title,
    descriptionText.slice(0, 600),
  );

  const identifier = posting?.identifier;
  const ldId = isObject(identifier) ? str(identifier.value) : str(identifier);
  const refId = ats?.id ?? ldId;

  return {
    title,
    company,
    location,
    workplace,
    employmentType: posting ? employmentOf(posting.employmentType) : "unknown",
    salary: posting ? salaryOf(posting.baseSalary) : null,
    postedAt: posting ? dateOf(posting.datePosted) : null,
    validThrough: posting ? dateOf(posting.validThrough) : null,
    description,
    sourceRef: ats && refId ? `${ats.provider}:${ats.board}:${refId}` : null,
  };
}
