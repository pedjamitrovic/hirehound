import { z } from "zod";
import { BANK_PREFIXES } from "../enums.ts";
import { Version } from "./common.ts";

export { BANK_PREFIXES };

/**
 * The experience bank (profile/experience-bank.yaml): the single source of truth for every claim a
 * CV may make. Entries have stable ids that CVs cite; ids are never reused, even after deletion.
 */

export type BankKind = keyof typeof BANK_PREFIXES;
export type BankPrefix = (typeof BANK_PREFIXES)[BankKind];

const idOf = (prefix: BankPrefix) =>
  z.string().regex(new RegExp(`^${prefix}-\\d{3,}$`), `expected an id like ${prefix}-001`);

/**
 * YYYY or YYYY-MM. A bare year written by hand (`end: 2015`) is a YAML number, so whole numbers are
 * accepted and turned into strings.
 */
export const YearMonth = z.preprocess(
  (value) => (typeof value === "number" && Number.isInteger(value) ? String(value) : value),
  z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "expected YYYY or YYYY-MM, e.g. 2021-03"),
);
export const EndDate = z.union([YearMonth, z.literal("present")]);

/** Fields every entry has. */
const common = {
  /**
   * false until you have reviewed the entry. AI-drafted entries start unconfirmed, and CVs are
   * only ever built from confirmed entries.
   */
  confirmed: z.boolean().default(false),
  /** Where it came from: an imported file ("imports/2026-11-18_cv.pdf"), "answers" or "manual". */
  source: z.string().optional(),
  tags: z.array(z.string()).default([]),
};

export const Achievement = z.object({
  id: idOf("ACH"),
  /** The claim in one line, as it could appear on a CV. */
  text: z.string().min(1),
  /** Context: scope, how, constraints. The verifier may rely on this too. */
  detail: z.string().optional(),
  /** Figures exactly as stated, e.g. "4 to 14 engineers", "40%", "18 months". */
  metrics: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  ...common,
});

/** start <= end, comparing YYYY or YYYY-MM strings; "present" is always later. */
function datesInOrder(r: { start?: string | undefined; end?: string | undefined }): boolean {
  if (!r.start || !r.end || r.end === "present") return true;
  return r.start.slice(0, r.end.length) <= r.end.slice(0, r.start.length);
}

const ORDER = { message: "start must not be after end", path: ["end"] };

export const Role = z
  .object({
    id: idOf("ROLE"),
    company: z.string().min(1),
    title: z.string().min(1),
    /** Optional only because a source may not state it: never guess, a gap question asks. */
    start: YearMonth.optional(),
    end: EndDate.optional(),
    location: z.string().optional(),
    employment_type: z
      .enum(["full-time", "part-time", "contract", "freelance", "internship"])
      .optional(),
    summary: z.string().optional(),
    achievements: z.array(Achievement).default([]),
    ...common,
  })
  .refine(datesInOrder, ORDER);

export const Project = z
  .object({
    id: idOf("PRJ"),
    name: z.string().min(1),
    /** Your role in it. */
    role: z.string().optional(),
    start: YearMonth.optional(),
    end: EndDate.optional(),
    url: z.url().optional(),
    summary: z.string().optional(),
    achievements: z.array(Achievement).default([]),
    ...common,
  })
  .refine(datesInOrder, ORDER);

export const Education = z
  .object({
    id: idOf("EDU"),
    institution: z.string().min(1),
    degree: z.string().optional(),
    field: z.string().optional(),
    start: YearMonth.optional(),
    end: EndDate.optional(),
    location: z.string().optional(),
    detail: z.string().optional(),
    ...common,
  })
  .refine(datesInOrder, ORDER);

export const Certification = z.object({
  id: idOf("CERT"),
  name: z.string().min(1),
  issuer: z.string().optional(),
  date: YearMonth.optional(),
  expires: YearMonth.optional(),
  url: z.url().optional(),
  ...common,
});

export const SkillGroup = z.object({
  id: idOf("SKL"),
  /** "Languages", "Cloud", "Leadership" */
  name: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
  ...common,
});

export const Language = z.object({
  id: idOf("LANG"),
  name: z.string().min(1),
  /** "Native", "C1", "Professional" */
  level: z.string().optional(),
  ...common,
});

export const Award = z.object({
  id: idOf("AWD"),
  name: z.string().min(1),
  issuer: z.string().optional(),
  date: YearMonth.optional(),
  detail: z.string().optional(),
  ...common,
});

export const BankFile = z
  .object({
    version: Version,
    /**
     * Highest number used so far per prefix, so a deleted id is never handed out again and an old
     * CV can never end up citing a different fact. Managed by the app.
     */
    id_counters: z.record(z.string(), z.number().int().nonnegative()).default({}),
    roles: z.array(Role).default([]),
    projects: z.array(Project).default([]),
    education: z.array(Education).default([]),
    certifications: z.array(Certification).default([]),
    skills: z.array(SkillGroup).default([]),
    languages: z.array(Language).default([]),
    awards: z.array(Award).default([]),
  })
  .superRefine((bank, ctx) => {
    const seen = new Map<string, string>();
    const check = (id: string, path: (string | number)[]) => {
      const where = path.join(".");
      const first = seen.get(id);
      if (first) {
        ctx.addIssue({ code: "custom", path, message: `duplicate id ${id} (also at ${first})` });
      } else seen.set(id, where);
    };
    const withAchievements = (
      list: { id: string; achievements: { id: string }[] }[],
      key: string,
    ) =>
      list.forEach((entry, i) => {
        check(entry.id, [key, i, "id"]);
        entry.achievements.forEach((a, j) => {
          check(a.id, [key, i, "achievements", j, "id"]);
        });
      });
    withAchievements(bank.roles, "roles");
    withAchievements(bank.projects, "projects");
    for (const key of ["education", "certifications", "skills", "languages", "awards"] as const) {
      bank[key].forEach((entry, i) => {
        check(entry.id, [key, i, "id"]);
      });
    }
  });

export type Achievement = z.infer<typeof Achievement>;
export type Role = z.infer<typeof Role>;
export type Project = z.infer<typeof Project>;
export type Education = z.infer<typeof Education>;
export type Certification = z.infer<typeof Certification>;
export type SkillGroup = z.infer<typeof SkillGroup>;
export type Language = z.infer<typeof Language>;
export type Award = z.infer<typeof Award>;
export type BankFile = z.infer<typeof BankFile>;

export type BankEntry =
  | Role
  | Achievement
  | Project
  | Education
  | Certification
  | SkillGroup
  | Language
  | Award;
