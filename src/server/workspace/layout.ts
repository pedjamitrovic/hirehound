import { join, relative, sep } from "node:path";

export const MANIFEST_FILE = "hirehound.yaml";

export const WORKSPACE_DIRS = [
  "profile",
  "profile/bases",
  "sources",
  "prompts",
  "templates",
  "jobs",
] as const;

export const PROFILE_FILES = {
  contact: "profile/contact.yaml",
  preferences: "profile/preferences.yaml",
  answers: "profile/answers.yaml",
  bank: "profile/experience-bank.yaml",
  onboarding: "profile/onboarding.yaml",
} as const;

export const IMPORTS_DIR = "profile/imports";

export const BASES_DIR = "profile/bases";
export const JOBS_DIR = "jobs";

export const JOB_FILES = {
  posting: "posting.md",
  postingHtml: "posting.html",
  status: "status.yaml",
  evaluation: "evaluation.md",
  cvBase: "cv.base.md",
  cv: "cv.md",
  changes: "changes.md",
  verification: "verification.json",
  cvPdf: "cv.pdf",
  aiLog: "ai-log.jsonl",
} as const;

export function jobDir(root: string, id: string): string {
  return join(root, JOBS_DIR, id);
}

/** Workspace-relative path with forward slashes, as shown in the UI and diagnostics. */
export function toWorkspacePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}
