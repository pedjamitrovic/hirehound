// HTTP API contract shared by server and web. Requests are Zod schemas (validated on the
// server); responses are plain types. API JSON uses camelCase; workspace files use snake_case.
import { z } from "zod";
import type { TransitionOption } from "../states.ts";
import { JobId, type SalaryRange } from "./common.ts";
import type { ScoreBand } from "./evaluation.ts";
import {
  EmploymentType,
  type PostingFrontmatter,
  type PostingSource,
  Workplace,
} from "./posting.ts";
import { JobState, Person, type StatusFile } from "./status.ts";

export type Diagnostic = {
  /** Workspace-relative path with forward slashes. */
  file: string;
  severity: "error" | "warning";
  message: string;
  line?: number;
};

export type JobSummary = {
  id: string;
  company: string;
  title: string;
  state: JobState;
  source: PostingSource | null;
  url: string | null;
  location: string | null;
  workplace: Workplace;
  salary: SalaryRange | null;
  score: number | null;
  band: ScoreBand | null;
  base: string | null;
  tags: string[];
  addedAt: string;
  updatedAt: string;
  appliedExternally: boolean;
  noteCount: number;
  errors: number;
  warnings: number;
};

export type JobDetail = {
  summary: JobSummary;
  posting: { frontmatter: PostingFrontmatter | null; body: string } | null;
  status: StatusFile | null;
  /** File names inside the job folder. */
  files: string[];
  diagnostics: Diagnostic[];
  transitions: TransitionOption[];
  hasRawHtml: boolean;
};

export type ProfileFileState = "ok" | "missing" | "invalid";

export type GitInfo = {
  root: string;
  remotes: { name: string; url: string }[];
  /** The workspace sits inside the Hirehound repo itself, which is public. */
  insideToolRepo: boolean;
};

export type WorkspaceInfo = {
  path: string;
  appVersion: string;
  profile: {
    contact: ProfileFileState;
    preferences: ProfileFileState;
    answers: ProfileFileState;
    contactName: string | null;
    bases: string[];
  };
  git: GitInfo | null;
  diagnostics: Diagnostic[];
  watcher: "watching" | "polling";
  jobCount: number;
};

export type ServerEvent =
  | { type: "hello"; appVersion: string }
  | { type: "job-upsert"; job: JobSummary }
  | { type: "job-remove"; id: string }
  | { type: "workspace"; info: WorkspaceInfo };

export type ApiErrorBody = {
  error: { code: string; message: string; issues?: { path: string; message: string }[] };
};

export const HttpUrl = z.url({ protocol: /^https?$/, error: "Enter an http(s) link" });

export const PreviewRequest = z.object({ url: HttpUrl });

export type DuplicateHint = Pick<JobSummary, "id" | "company" | "title" | "state">;

/** What the server extracted from a URL; nothing is written until the user confirms. */
export type PostingDraft = {
  /** Refers to the fetched snapshot held in memory by the server for a few minutes. */
  token: string;
  url: string;
  finalUrl: string;
  source: PostingSource;
  sourceRef: string | null;
  company: string | null;
  title: string | null;
  location: string | null;
  workplace: Workplace;
  employmentType: EmploymentType;
  salary: SalaryRange | null;
  postedAt: string | null;
  validThrough: string | null;
  text: string;
  warnings: string[];
  duplicates: DuplicateHint[];
};

const JobFields = z.object({
  company: z.string().trim().min(1, "Company is required").max(200),
  title: z.string().trim().min(1, "Role title is required").max(300),
  location: z.string().trim().max(200).optional(),
  workplace: Workplace.default("unknown"),
  employmentType: EmploymentType.default("unknown"),
});

export const CreateJobRequest = z.discriminatedUnion("kind", [
  JobFields.extend({ kind: z.literal("url"), token: z.string().min(1) }),
  JobFields.extend({
    kind: z.literal("text"),
    text: z.string().trim().min(20, "Paste the full posting text").max(200_000),
    url: HttpUrl.optional(),
  }),
]);

export const TransitionBody = z.object({
  to: JobState,
  method: z.literal("external").optional(),
  reason: z.string().max(2000).optional(),
});

export const BulkTransitionBody = TransitionBody.extend({
  ids: z.array(JobId).min(1).max(500),
});

export type BulkTransitionResult = { results: { id: string; ok: boolean; message?: string }[] };

export const NoteBody = z.object({ text: z.string().trim().min(1, "Note is empty").max(10_000) });

export const ContactBody = Person;

export type CreateJobRequest = z.input<typeof CreateJobRequest>;
export type TransitionBody = z.input<typeof TransitionBody>;
export type BulkTransitionBody = z.input<typeof BulkTransitionBody>;
export type NoteBody = z.input<typeof NoteBody>;
export type ContactBody = z.input<typeof ContactBody>;
