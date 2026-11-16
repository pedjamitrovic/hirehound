import { z } from "zod";
import { CountryCode, SalaryRange, Version } from "./common.ts";

export const Seniority = z.enum([
  "mid",
  "senior",
  "staff",
  "principal",
  "manager",
  "senior-manager",
  "director",
  "vp",
]);

export const CompanySize = z.enum(["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"]);

// Note: `.prefault({})` (not `.default({})`) so a missing section is parsed and gets inner defaults.
export const Preferences = z.object({
  version: Version,
  roles: z
    .object({
      seniority: z.array(Seniority).default([]),
      /** Target titles live on each base profile; these are extra discovery keywords. */
      include_title_keywords: z.array(z.string()).default([]),
      /** Hard filter during discovery, e.g. "intern", "sales". */
      exclude_title_keywords: z.array(z.string()).default([]),
    })
    .prefault({}),
  location: z.object({
    based_in: z.object({ country: CountryCode, city: z.string().optional() }),
    remote: z.enum(["remote-only", "hybrid-ok", "onsite-ok"]).default("hybrid-ok"),
    /** Free text the evaluator understands: "Remote (EU)", "Berlin". */
    acceptable_locations: z.array(z.string()).default([]),
    /** IANA time zone, e.g. "Europe/Belgrade". */
    timezone: z.string().min(1),
    /** Acceptable team time zones as UTC offsets in hours, e.g. [-1, 3]. */
    acceptable_utc_offsets: z.tuple([z.number(), z.number()]).optional(),
    /** Where you may work without sponsorship: ["RS", "EU"]. */
    work_authorization: z.array(z.string()).default([]),
    needs_sponsorship_elsewhere: z.boolean().default(true),
    open_to_relocation: z.boolean().default(false),
  }),
  compensation: z
    .object({
      /** Below this, the evaluation flags the role. */
      floor: SalaryRange.optional(),
      target: SalaryRange.optional(),
    })
    .prefault({}),
  company: z
    .object({
      /** Empty means any size. */
      sizes: z.array(CompanySize).default([]),
      include_industries: z.array(z.string()).default([]),
      /** Hard filter. */
      exclude_industries: z.array(z.string()).default([]),
      /** Hard filter. */
      exclude_companies: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Free text, judged by the evaluator. */
  deal_breakers: z.array(z.string()).default([]),
  scoring: z
    .object({
      /** The guardrail warns before approving below this score. */
      threshold: z.number().int().min(0).max(100).default(70),
    })
    .prefault({}),
  cover_letter: z
    .object({
      policy: z.enum(["always", "when-requested", "never"]).default("when-requested"),
    })
    .prefault({}),
  apply: z.object({ mode: z.enum(["manual", "assisted"]).default("manual") }).prefault({}),
  cv: z.object({ max_pages: z.number().int().min(1).max(4).default(2) }).prefault({}),
});

export type Preferences = z.infer<typeof Preferences>;
