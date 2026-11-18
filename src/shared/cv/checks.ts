import { type IndexedEntry, indexBank } from "../bank.ts";
import type { BankFile } from "../schemas/bank.ts";
import { type Claim, cvClaims } from "./claims.ts";
import type { CvDoc } from "./types.ts";

/**
 * Deterministic checks for a tailored CV (PRD 7.3). They are blocking: a CV with an error here
 * cannot reach `ready`. Every check compares a claim only with the bank entries it cites (and, for
 * an achievement, the role or project it belongs to), so the result never depends on a model.
 */

export const CHECK_IDS = ["format", "evidence", "numbers", "companies", "titles", "dates"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type CheckIssue = {
  check: CheckId;
  /** Claim index (see cvClaims), or -1 for an issue about the whole file. */
  n: number;
  line: number;
  severity: "error" | "warning";
  message: string;
};

const SKIP_KEYS = new Set(["id", "source", "confirmed", "tags", "achievements", "url"]);

/** Every fact-bearing string of an entry, for comparison with a claim. */
function entryStrings(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (SKIP_KEYS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") out.push(item);
    }
  }
  return out;
}

/** The cited entries plus the role or project each cited achievement belongs to. */
function citedEntries(ids: readonly string[], index: Map<string, IndexedEntry>): IndexedEntry[] {
  const out: IndexedEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined) => {
    const entry = id ? index.get(id) : undefined;
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
    if (entry.parent) add(entry.parent);
  };
  for (const id of ids) add(id);
  return out;
}

// ---------- Numbers ----------

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

const LETTER = /\p{L}/u;

/** "1,200" and "1.200" -> "1200"; "3,5" -> "3.5"; "03" -> "3". */
function canonicalNumber(raw: string): string {
  let value = raw;
  if (/^\d{1,3}([,.]\d{3})+$/.test(value)) value = value.replace(/[,.]/g, "");
  else value = value.replace(",", ".");
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : raw;
}

type NumberToken = { raw: string; value: string };

/**
 * Numbers in a text, as written ("40%", "1,200", "two"). Digits glued to letters on both sides
 * are names, not figures (B2B, K8s, H2O), and are skipped.
 */
export function numbersIn(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const at = match.index ?? 0;
    const before = text[at - 1] ?? "";
    const after = text[at + match[0].length] ?? "";
    if (LETTER.test(before) && LETTER.test(after)) continue;
    out.push({ raw: match[0], value: canonicalNumber(match[0]) });
  }
  for (const match of text.matchAll(/\p{L}+/gu)) {
    const n = NUMBER_WORDS[match[0].toLowerCase()];
    if (n !== undefined) out.push({ raw: match[0], value: String(n) });
  }
  return out;
}

// ---------- Dates ----------

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

type DateMention =
  | { raw: string; year: string; month: string | null }
  | { raw: string; present: true };

const DATE_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => DateMention | null }[] = [
  {
    // 2021-03
    re: /(?<!\d)((?:19|20)\d{2})-(0[1-9]|1[0-2])(?!\d)/g,
    read: (m) => ({ raw: m[0], year: m[1] ?? "", month: m[2] ?? null }),
  },
  {
    // 03/2021
    re: /(?<!\d)(0?[1-9]|1[0-2])\/((?:19|20)\d{2})(?!\d)/g,
    read: (m) => ({ raw: m[0], year: m[2] ?? "", month: (m[1] ?? "").padStart(2, "0") }),
  },
  {
    // Mar 2021, March 2021, Sept. 2021
    re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d{2})(?!\d)/gi,
    read: (m) => ({
      raw: m[0],
      year: m[2] ?? "",
      month: MONTHS[(m[1] ?? "").toLowerCase()] ?? null,
    }),
  },
  {
    // 2021 (YYYY-MM forms are blanked out by the patterns above)
    re: /(?<!\d)((?:19|20)\d{2})(?!\d)/g,
    read: (m) => ({ raw: m[0], year: m[1] ?? "", month: null }),
  },
  {
    re: /\b(present|now|current|today|ongoing)\b/gi,
    read: (m) => ({ raw: m[0], present: true }),
  },
];

/** Date mentions in a text, and the text with them blanked out (so numbers are not counted twice). */
export function datesIn(text: string): { dates: DateMention[]; rest: string } {
  let rest = text;
  const dates: DateMention[] = [];
  for (const pattern of DATE_PATTERNS) {
    rest = rest.replace(pattern.re, (...args) => {
      const match = args.slice(0, -2) as unknown as RegExpMatchArray;
      const mention = pattern.read(match);
      if (mention) dates.push(mention);
      return " ".repeat(String(args[0]).length);
    });
  }
  return { dates, rest };
}

type BankDate = { year: string; month: string | null } | "present";

function bankDates(entries: readonly IndexedEntry[]): BankDate[] {
  const out: BankDate[] = [];
  for (const { entry } of entries) {
    const e = entry as Record<string, unknown>;
    for (const key of ["start", "end", "date", "expires"]) {
      const value = e[key];
      if (value === "present") out.push("present");
      else if (typeof value === "string" && /^\d{4}(-\d{2})?$/.test(value)) {
        out.push({ year: value.slice(0, 4), month: value.length > 4 ? value.slice(5, 7) : null });
      }
    }
  }
  return out;
}

function dateProblem(mention: DateMention, known: readonly BankDate[]): string | null {
  if ("present" in mention) {
    return known.includes("present")
      ? null
      : `"${mention.raw}": none of the cited entries ends at present`;
  }
  const dated = known.filter((d): d is Exclude<BankDate, "present"> => d !== "present");
  if (dated.length === 0) return `"${mention.raw}": the cited entries have no dates`;
  if (mention.month === null) {
    return dated.some((d) => d.year === mention.year)
      ? null
      : `"${mention.raw}" is not a start or end year of the cited entries`;
  }
  if (dated.some((d) => d.year === mention.year && d.month === mention.month)) return null;
  if (dated.some((d) => d.year === mention.year && d.month === null)) {
    return `"${mention.raw}": the experience bank only has the year, not the month`;
  }
  return `"${mention.raw}" is not a start or end date of the cited entries`;
}

// ---------- Names ----------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namePattern(name: string): string {
  return name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

function mentions(text: string, name: string): boolean {
  const words = namePattern(name);
  if (!words) return false;
  return new RegExp(`(?<![\\p{L}\\d])${words}(?![\\p{L}\\d])`, "iu").test(text);
}

// Separators between the parts of an entry heading: , | middle dot - en dash em dash : ( ) / at @
const SEP = "(?:[,|\\u00b7:()/@\\-\\u2013\\u2014]|\\bat\\b)";

/**
 * The name appears in a heading as a part of its own, between separators. "Senior Engineering
 * Manager" does not count as the title "Engineering Manager": a changed title is a changed claim.
 */
function standsAlone(text: string, name: string): boolean {
  const words = namePattern(name);
  if (!words) return false;
  return new RegExp(`(?:^|${SEP})\\s*${words}\\s*(?:$|${SEP})`, "iu").test(text.trim());
}

// ---------- The checks ----------

export type CheckResult = {
  issues: CheckIssue[];
  /** Errors per check, for the summary bar. */
  errors: Record<CheckId, number>;
};

export function emptyCheckCounts(): Record<CheckId, number> {
  return Object.fromEntries(CHECK_IDS.map((id) => [id, 0])) as Record<CheckId, number>;
}

/**
 * Runs every deterministic check on a parsed tailored CV (or cover letter) against the experience
 * bank. `context` is extra text claims may draw figures and names from: for a cover letter, the
 * posting, so "your 60 services" is fine when the posting says so.
 */
export function checkTailoredCv(
  doc: CvDoc,
  bank: BankFile | null,
  options: { context?: string | undefined } = {},
): CheckResult {
  const index = bank ? indexBank(bank) : new Map<string, IndexedEntry>();
  const companies = [
    ...new Set(bank?.roles.map((r) => r.company.trim()).filter((c) => c.length >= 2) ?? []),
  ];
  const issues: CheckIssue[] = [];
  const add = (check: CheckId, claim: Claim, message: string) =>
    issues.push({ check, n: claim.n, line: claim.line, severity: "error", message });

  for (const claim of cvClaims(doc)) {
    // Evidence: cited, known and confirmed.
    if (claim.ev.length === 0) {
      add("evidence", claim, "No evidence marker: every claim cites the experience bank");
      continue;
    }
    let usable = true;
    for (const id of claim.ev) {
      const entry = index.get(id);
      if (!entry) {
        add("evidence", claim, `${id} is not in the experience bank`);
        usable = false;
      } else if (!entry.entry.confirmed) {
        add("evidence", claim, `${id} is not confirmed in the experience bank yet`);
      }
    }
    if (!usable) continue;

    const cited = citedEntries(claim.ev, index);
    const corpus = cited.flatMap((e) => entryStrings(e.entry as Record<string, unknown>));
    if (options.context) corpus.push(options.context);
    const corpusText = corpus.join("\n");

    // Dates (entry headings) and numbers.
    let numberText = claim.text;
    if (claim.kind === "entry") {
      const { dates, rest } = datesIn(claim.text);
      numberText = rest;
      const known = bankDates(cited);
      for (const mention of dates) {
        const problem = dateProblem(mention, known);
        if (problem) add("dates", claim, problem);
      }
    }
    const available = new Set(numbersIn(corpusText).map((t) => t.value));
    for (const date of bankDates(cited)) {
      if (date === "present") continue;
      available.add(String(Number(date.year)));
      if (date.month) available.add(String(Number(date.month)));
    }
    const reported = new Set<string>();
    for (const token of numbersIn(numberText)) {
      if (available.has(token.value) || reported.has(token.value)) continue;
      reported.add(token.value);
      add("numbers", claim, `"${token.raw}" does not appear in ${claim.ev.join(", ")}`);
    }

    // Company names: a company the bank knows may only appear when a cited entry is about it.
    for (const company of companies) {
      if (mentions(claim.text, company) && !mentions(corpusText, company)) {
        add("companies", claim, `Mentions ${company}, but no cited entry is about ${company}`);
      }
    }

    // Entry headings name the entries they cite exactly as the bank does.
    if (claim.kind === "entry") {
      for (const { id, kind, entry } of cited) {
        if (!claim.ev.includes(id)) continue;
        const e = entry as Record<string, unknown>;
        if (kind === "role") {
          if (typeof e.title === "string" && !standsAlone(claim.text, e.title)) {
            add("titles", claim, `The job title must be "${e.title}" as in ${id}`);
          }
          if (typeof e.company === "string" && !standsAlone(claim.text, e.company)) {
            add("companies", claim, `The company must be written "${e.company}" as in ${id}`);
          }
        } else if (kind === "project" && typeof e.name === "string") {
          if (!standsAlone(claim.text, e.name))
            add("companies", claim, `The project must be named "${e.name}" as in ${id}`);
        } else if (kind === "education" && typeof e.institution === "string") {
          if (!standsAlone(claim.text, e.institution)) {
            add(
              "companies",
              claim,
              `The institution must be written "${e.institution}" as in ${id}`,
            );
          }
        }
      }
    }
  }

  const errors = emptyCheckCounts();
  for (const issue of issues) if (issue.severity === "error") errors[issue.check] += 1;
  return { issues, errors };
}
