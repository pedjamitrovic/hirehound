// HTTP API contract shared by server and web. Requests are Zod schemas (validated on the
// server); responses are plain types. API JSON uses camelCase; workspace files use snake_case.
import { z } from "zod";
import type { CheckId, CheckIssue } from "../cv/checks.ts";
import type { Inline } from "../cv/types.ts";
import type { ScoreResult } from "../score.ts";
import type { TransitionOption } from "../states.ts";
import { BaseId, JobId, type SalaryRange } from "./common.ts";
import type { EvaluationFrontmatter, ScoreBand } from "./evaluation.ts";
import {
  EmploymentType,
  type PostingFrontmatter,
  type PostingSource,
  Workplace,
} from "./posting.ts";
import { JobState, Person, type StatusFile } from "./status.ts";
import type { ClaimVerdict, RenderInfo } from "./verification.ts";

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
  /** The evaluation's verdict (block G). */
  recommendation: "apply" | "stretch" | "skip" | null;
  base: string | null;
  tags: string[];
  addedAt: string;
  updatedAt: string;
  appliedExternally: boolean;
  noteCount: number;
  errors: number;
  warnings: number;
  /** Moves offered from the current state, including blocked ones with the reason. */
  transitions: TransitionOption[];
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
  usage: JobUsage;
};

/** AI work on one job so far, from its ai-log.jsonl. */
export type JobUsage = {
  tasks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

/** A bank entry as the review shows it behind an evidence chip. */
export type EvidenceInfo = {
  id: string;
  kind: string | null;
  label: string;
  confirmed: boolean;
  /** Every field, as the verifier saw it. */
  detail: string;
};

export type EvaluationView = {
  evaluation: EvaluationFrontmatter | null;
  score: ScoreResult | null;
  /** The posting or the experience bank changed after the evaluation was written. */
  stale: { posting: boolean; bank: boolean };
  threshold: number;
  evidence: Record<string, EvidenceInfo>;
  /** Base CVs to tailor from. */
  bases: { id: string; label: string }[];
};

export type ClaimView = {
  n: number;
  kind: "entry" | "paragraph" | "bullet";
  inline: Inline[];
  text: string;
  ev: string[];
  line: number;
  diff: "same" | "changed" | "added";
  /** The base CV's version of a changed claim. */
  baseText?: string;
  /** null while this exact claim has not been verified. */
  verdict: ClaimVerdict | null;
  reason?: string;
  suggestion?: string;
  /** Checks that failed for this claim. */
  issues: CheckIssue[];
};

export type CvRow =
  | { t: "section"; text: string; line: number }
  | { t: "claim"; claim: ClaimView }
  | { t: "removed"; text: string; ev: string[] };

export type CvView = {
  text: string;
  sha256: string;
  /** Format problems: the dialect parser and the frontmatter. */
  issues: CvIssue[];
  base: { id: string; label: string; changedSinceTailoring: boolean } | null;
  headline: string | null;
  theme: "classic" | "modern";
  generatedAt: string | null;
  notes: string | null;
  rows: CvRow[];
  /** Deterministic checks of the current text; null until checked. */
  checks: { issues: CheckIssue[]; errors: Record<CheckId, number> } | null;
  verification: {
    state: "none" | "stale" | "current";
    checkedAt: string | null;
    supported: number;
    weakened: number;
    unsupported: number;
    unverified: number;
  };
  render: (RenderInfo & { current: boolean }) | null;
  evidence: Record<string, EvidenceInfo>;
  /** Ids whose bank content changed after the CV was verified. */
  bankChanged: string[];
  approve: {
    allowed: boolean;
    /** Why Approve is blocked, in order. */
    blockers: string[];
    /** Score below the threshold: approving needs a reason. */
    needsOverride: boolean;
    score: number | null;
    threshold: number;
  };
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
    /** Changes whenever any profile file changes; editors reload on it. */
    revision: string;
    contact: ProfileFileState;
    preferences: ProfileFileState;
    answers: ProfileFileState;
    contactName: string | null;
    bases: string[];
    bank: { state: ProfileFileState; entries: number; confirmed: number };
  };
  git: GitInfo | null;
  diagnostics: Diagnostic[];
  watcher: "watching" | "polling";
  jobCount: number;
};

export type AiSettings = {
  engine: "anthropic-api" | "claude-code";
  model: string;
  /** Never the key itself: only whether one is set and where it comes from. */
  apiKey: { present: boolean; source: "env" | "file" | null };
};

/** A background job (AI task, PDF render) reported to every open tab. */
export type TaskInfo = {
  id: string;
  kind: string;
  label: string;
  /** The job this task works on, if any. One task per job runs at a time. */
  jobId?: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Latest progress line, e.g. "Reading 3 files" or "Writing (1.2k tokens)". */
  progress?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** Small, task-specific result for the UI (ids created, file written). */
  result?: unknown;
};

/** A profile YAML file as the editor needs it: value, version for safe saves, problems. */
export type ProfileFile<T> = {
  value: T | null;
  /** The file exists but has no content yet (missing or commented-out template). */
  empty: boolean;
  /** SHA-256 of the file as read; send it back when saving so a newer edit is never overwritten. */
  sha256: string | null;
  diagnostics: Diagnostic[];
};

export type BaseSummary = {
  id: string;
  label: string;
  track: "management" | "ic" | null;
  theme: "classic" | "modern";
  headline: string | null;
  errors: number;
  warnings: number;
  updatedAt: string;
};

export type CvIssue = { line: number; col: number; severity: "error" | "warning"; message: string };

export type BaseDetail = {
  summary: BaseSummary;
  text: string;
  sha256: string;
  issues: CvIssue[];
  /** Evidence ids cited by the CV, with a label for chips. */
  evidence: { id: string; label: string; confirmed: boolean }[];
};

export type ImportInfo = {
  /** File name inside profile/imports. */
  name: string;
  kind: "text" | "pdf" | "unsupported";
  origin: string;
  size: number;
  /** Characters of extracted text (text kinds). */
  chars: number | null;
  error: string | null;
};

export type ProfileFileSave<T> = { value: T; expectedSha256: string | null };

export type ServerEvent =
  | { type: "hello"; appVersion: string }
  | { type: "task"; task: TaskInfo }
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

export const TailorBody = z.object({
  /** Base CV to tailor from; defaults to the evaluation's choice. */
  base: BaseId.optional(),
  /** "Request changes": what should be different. Revises the current tailored CV. */
  feedback: z.string().trim().min(1, "Say what should change").max(4000).optional(),
});

export const CvSaveBody = z.object({
  text: z.string().max(200_000),
  expectedSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export const ApproveBody = z.object({
  /** Required when the fit score is below the threshold. */
  overrideReason: z.string().trim().max(2000).optional(),
});

export type TailorBody = z.input<typeof TailorBody>;
export type CvSaveBody = z.input<typeof CvSaveBody>;
export type ApproveBody = z.input<typeof ApproveBody>;

export type CreateJobRequest = z.input<typeof CreateJobRequest>;
export type TransitionBody = z.input<typeof TransitionBody>;
export type BulkTransitionBody = z.input<typeof BulkTransitionBody>;
export type NoteBody = z.input<typeof NoteBody>;
export type ContactBody = z.input<typeof ContactBody>;
