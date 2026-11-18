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
