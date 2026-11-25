// Plain value lists shared by the Zod schemas and the UI. Kept free of Zod so the browser
// bundle can use them without pulling the schema library in.

export const WORKPLACES = ["remote", "hybrid", "onsite", "unknown"] as const;

export const EMPLOYMENT_TYPES = [
  "full-time",
  "part-time",
  "contract",
  "internship",
  "unknown",
] as const;

export const POSTING_SOURCES = [
  "manual-url",
  "manual-text",
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
  "linkedin-email",
  "browser",
] as const;

/** Applicant tracking systems whose public job boards Hirehound can scan (M5). */
export const ATS_PROVIDERS = ["greenhouse", "lever", "ashby"] as const;

/** How a cover letter makes its case: fit to the requirements, results first, motivation, short. */
export const COVER_LETTER_ANGLES = ["fit", "impact", "motivation", "brief"] as const;

/** Experience bank entry id prefixes per kind (ROLE-003, ACH-014, ...). */
export const BANK_PREFIXES = {
  role: "ROLE",
  achievement: "ACH",
  project: "PRJ",
  education: "EDU",
  certification: "CERT",
  skill: "SKL",
  language: "LANG",
  award: "AWD",
} as const;
