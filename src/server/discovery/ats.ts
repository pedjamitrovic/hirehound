import { z } from "zod";
import type { SalaryRange } from "../../shared/schemas/common.ts";
import type { Portal } from "../../shared/schemas/portals.ts";
import type { EmploymentType, Workplace } from "../../shared/schemas/posting.ts";
import { atsFromUrl, descriptionToText, workplaceFrom } from "../jobs/extract.ts";
import { htmlToText } from "../jobs/html-text.ts";
import { normalizePostingText } from "../jobs/snapshot.ts";
import { APP_VERSION } from "../version.ts";

/** A posting from a job board, normalised across providers. */
export type DiscoveredPosting = {
  provider: Portal["provider"] | "linkedin-email";
  /** Provider-scoped id, the dedupe key: "greenhouse:acme:4012345". */
  sourceRef: string;
  company: string;
  title: string;
  url: string;
  location: string | null;
  workplace: Workplace;
  employmentType: EmploymentType;
  salary: SalaryRange | null;
  postedAt: string | null;
  /** The posting as readable text (headings as ##, bullets as -). */
  text: string;
};

export class BoardError extends Error {}

const USER_AGENT = `Mozilla/5.0 (compatible; Hirehound/${APP_VERSION}; +https://github.com/pedjamitrovic/hirehound)`;

/** The board's public API address. No keys and no login: only what the company publishes. */
export function boardApiUrl(portal: Pick<Portal, "provider" | "board" | "region">): string {
  const board = encodeURIComponent(portal.board);
  switch (portal.provider) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
    case "lever":
      return `https://api${portal.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${board}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`;
  }
}

/** The public page where people see the board, for links in the UI. */
export function boardPageUrl(portal: Pick<Portal, "provider" | "board" | "region">): string {
  const board = encodeURIComponent(portal.board);
  switch (portal.provider) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${board}`;
    case "lever":
      return `https://jobs${portal.region === "eu" ? ".eu" : ""}.lever.co/${board}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${board}`;
  }
}

/** Recognises a board (or job) link: "https://jobs.lever.co/acme/123" -> lever, acme. */
export function boardFromUrl(raw: string): Pick<Portal, "provider" | "board" | "region"> | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const ats = atsFromUrl(url);
  if (!ats || !["greenhouse", "lever", "ashby"].includes(ats.provider)) return null;
  return {
    provider: ats.provider as Portal["provider"],
    board: ats.board,
    region: url.hostname === "jobs.eu.lever.co" ? "eu" : "global",
  };
}

// ---------- Provider payloads (lenient: unknown fields are ignored, odd ones skipped) ----------

const Greenhouse = z.object({
  jobs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      title: z.string(),
      absolute_url: z.string(),
      location: z.object({ name: z.string().nullish() }).nullish(),
      first_published: z.string().nullish(),
      content: z.string().nullish(),
    }),
  ),
});

const Lever = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    categories: z
      .object({
        location: z.string().nullish(),
        commitment: z.string().nullish(),
        allLocations: z.array(z.string()).nullish(),
      })
      .nullish(),
    createdAt: z.number().nullish(),
    descriptionPlain: z.string().nullish(),
    lists: z
      .array(z.object({ text: z.string().nullish(), content: z.string().nullish() }))
      .nullish(),
    additionalPlain: z.string().nullish(),
    workplaceType: z.string().nullish(),
    salaryRange: z
      .object({
        min: z.number().nullish(),
        max: z.number().nullish(),
        currency: z.string().nullish(),
        interval: z.string().nullish(),
      })
      .nullish(),
  }),
);

const Ashby = z.object({
  jobs: z.array(
    z.object({
      id: z.string().nullish(),
      title: z.string(),
      location: z.string().nullish(),
      isListed: z.boolean().nullish(),
      isRemote: z.boolean().nullish(),
      workplaceType: z.string().nullish(),
      employmentType: z.string().nullish(),
      publishedAt: z.string().nullish(),
      jobUrl: z.string(),
      descriptionPlain: z.string().nullish(),
      descriptionHtml: z.string().nullish(),
      compensation: z
        .object({ scrapeableCompensationSalarySummary: z.string().nullish() })
        .nullish(),
    }),
  ),
});

const dateOnly = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

const EMPLOYMENT: Record<string, EmploymentType> = {
  fulltime: "full-time",
  "full-time": "full-time",
  parttime: "part-time",
  "part-time": "part-time",
  contract: "contract",
  contractor: "contract",
  temporary: "contract",
  intern: "internship",
  internship: "internship",
};

function employmentOf(value: string | null | undefined): EmploymentType {
  if (!value) return "unknown";
  return (
    EMPLOYMENT[value.toLowerCase().replace(/[\s_]+/g, "")] ??
    EMPLOYMENT[value.toLowerCase()] ??
    "unknown"
  );
}

function workplaceOf(
  type: string | null | undefined,
  ...texts: (string | null | undefined)[]
): Workplace {
  const t = type?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (t === "remote") return "remote";
  if (t === "hybrid") return "hybrid";
  if (t === "onsite") return "onsite";
  return workplaceFrom(null, ...texts.map((x) => x ?? null));
}

const PERIOD: Record<string, SalaryRange["period"]> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-day-salary": "day",
  "per-hour-wage": "hour",
};

/** Turns a board's JSON into postings. Exported for tests with recorded payloads. */
export function parseBoard(portal: Portal, payload: unknown): DiscoveredPosting[] {
  const base = (ref: string) => ({
    provider: portal.provider,
    sourceRef: `${portal.provider}:${portal.board}:${ref}`,
    company: portal.company,
  });
  if (portal.provider === "greenhouse") {
    const data = Greenhouse.safeParse(payload);
    if (!data.success)
      throw new BoardError("The Greenhouse board answered in an unexpected format.");
    return data.data.jobs.map((j) => {
      const location = j.location?.name?.trim() || null;
      return {
        ...base(String(j.id)),
        title: j.title.trim(),
        url: j.absolute_url,
        location,
        workplace: workplaceOf(null, location, j.title),
        employmentType: "unknown",
        salary: null,
        postedAt: dateOnly(j.first_published),
        text: normalizePostingText(j.content ? descriptionToText(j.content) : ""),
      };
    });
  }
  if (portal.provider === "lever") {
    const data = Lever.safeParse(payload);
    if (!data.success) throw new BoardError("The Lever board answered in an unexpected format.");
    return data.data.map((j) => {
      const location = j.categories?.location?.trim() || null;
      const sections = (j.lists ?? [])
        .filter((l) => l.text || l.content)
        .map(
          (l) =>
            `${l.text ? `## ${l.text.trim()}\n\n` : ""}${htmlToText(`<ul>${l.content ?? ""}</ul>`)}`,
        );
      const range = j.salaryRange;
      const currency = range?.currency?.toUpperCase();
      const period = PERIOD[range?.interval ?? ""] ?? "year";
      const salary: SalaryRange | null =
        range && currency && /^[A-Z]{3}$/.test(currency) && (range.min != null || range.max != null)
          ? {
              ...(range.min != null ? { min: range.min } : {}),
              ...(range.max != null ? { max: range.max } : {}),
              currency,
              period,
              raw: `${currency} ${range.min ?? ""}-${range.max ?? ""} per ${period}`,
            }
          : null;
      return {
        ...base(j.id),
        title: j.text.trim(),
        url: j.hostedUrl,
        location,
        workplace: workplaceOf(j.workplaceType, location, j.text),
        employmentType: employmentOf(j.categories?.commitment),
        salary,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
        text: normalizePostingText(
          [j.descriptionPlain ?? "", ...sections, j.additionalPlain ?? ""]
            .filter((s) => s.trim())
            .join("\n\n"),
        ),
      };
    });
  }
  const data = Ashby.safeParse(payload);
  if (!data.success) throw new BoardError("The Ashby board answered in an unexpected format.");
  return data.data.jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const id = j.id ?? new URL(j.jobUrl).pathname.split("/").filter(Boolean).at(-1) ?? j.jobUrl;
      const location = j.location?.trim() || null;
      const pay = j.compensation?.scrapeableCompensationSalarySummary?.trim();
      const description = j.descriptionPlain?.trim()
        ? j.descriptionPlain
        : j.descriptionHtml
          ? htmlToText(j.descriptionHtml)
          : "";
      return {
        ...base(id),
        title: j.title.trim(),
        url: j.jobUrl,
        location,
        workplace: j.isRemote ? "remote" : workplaceOf(j.workplaceType, location, j.title),
        employmentType: employmentOf(j.employmentType),
        salary: null,
        postedAt: dateOnly(j.publishedAt),
        text: normalizePostingText(pay ? `${description}\n\nCompensation: ${pay}` : description),
      };
    });
}

/** Reads one board. Throws BoardError with a readable message when the board cannot be read. */
export async function fetchBoard(
  portal: Portal,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredPosting[]> {
  const url = boardApiUrl(portal);
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
  } catch (error) {
    throw new BoardError(
      (error as Error).name === "TimeoutError"
        ? `${portal.company}: the board did not answer in time.`
        : `${portal.company}: could not reach ${new URL(url).hostname}.`,
    );
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new BoardError(
      `${portal.company}: there is no ${portal.provider} board called "${portal.board}". Check the board name in its URL.`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new BoardError(`${portal.company}: the board answered with an error (${res.status}).`);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new BoardError(`${portal.company}: the board did not answer with JSON.`);
  }
  return parseBoard(portal, payload);
}
