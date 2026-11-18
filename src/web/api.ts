import type { AnswersFile } from "../shared/schemas/answers.ts";
import type {
  AiSettings,
  ApiErrorBody,
  ApplicationView,
  AppliedBody,
  ApproveBody,
  AssistAnswerBody,
  AssistState,
  BaseDetail,
  BaseSummary,
  BulkTransitionBody,
  BulkTransitionResult,
  ContactBody,
  CoverLetterBody,
  CoverLetterView,
  CreateJobRequest,
  CvView,
  EvaluationView,
  ImportInfo,
  JobDetail,
  JobSummary,
  NoteBody,
  PostingDraft,
  ProfileFile,
  TailorBody,
  TaskInfo,
  TransitionBody,
  WorkspaceInfo,
} from "../shared/schemas/api.ts";
import type { BankFile, BankKind } from "../shared/schemas/bank.ts";
import type { Contact } from "../shared/schemas/contact.ts";
import type { OnboardingFile } from "../shared/schemas/onboarding.ts";
import type { Preferences } from "../shared/schemas/preferences.ts";

/** A bank edit, as accepted by POST /api/profile/bank/ops. */
export type BankOpInput =
  | { op: "upsert"; kind: BankKind; entry: Record<string, unknown>; parent?: string }
  | { op: "delete"; id: string }
  | { op: "confirm"; ids: string[]; confirmed: boolean };

export type BaseSpecInput = {
  label: string;
  track: "management" | "ic";
  target_titles: string[];
  emphasis: string[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: { path: string; message: string }[];
  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.issues = body.issues ?? [];
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: raw
        ? { "content-type": "application/octet-stream" }
        : body === undefined
          ? {}
          : { "content-type": "application/json" },
      body: raw ?? (body === undefined ? null : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError(0, {
      code: "offline",
      message: "Cannot reach the Hirehound server. Is it still running?",
    });
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = (data as ApiErrorBody | null)?.error ?? {
      code: "http",
      message: `Request failed (${res.status})`,
    };
    throw new ApiError(res.status, error);
  }
  return data as T;
}

const job = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

export const api = {
  workspace: () => request<WorkspaceInfo>("GET", "/api/workspace"),
  jobs: () => request<JobSummary[]>("GET", "/api/jobs"),
  job: (id: string) => request<JobDetail>("GET", job(id)),
  preview: (url: string) => request<PostingDraft>("POST", "/api/postings/preview", { url }),
  createJob: (body: CreateJobRequest) => request<JobDetail>("POST", "/api/jobs", body),
  transition: (id: string, body: TransitionBody) =>
    request<JobDetail>("POST", `${job(id)}/transitions`, body),
  bulkTransition: (body: BulkTransitionBody) =>
    request<BulkTransitionResult>("POST", "/api/jobs/bulk-transition", body),
  addNote: (id: string, body: NoteBody) => request<JobDetail>("POST", `${job(id)}/notes`, body),
  deleteNote: (id: string, index: number, at: string) =>
    request<JobDetail>("DELETE", `${job(id)}/notes/${index}?at=${encodeURIComponent(at)}`),
  addContact: (id: string, body: ContactBody) =>
    request<JobDetail>("POST", `${job(id)}/contacts`, body),
  deleteContact: (id: string, index: number, name: string) =>
    request<JobDetail>("DELETE", `${job(id)}/contacts/${index}?name=${encodeURIComponent(name)}`),
  openFolder: (id: string) => request<void>("POST", `${job(id)}/open-folder`, {}),
  rawPostingUrl: (id: string) => `${job(id)}/raw/posting.html`,

  // M3: evaluate, tailor, check, review, approve. Long work returns a TaskInfo (202).
  evaluate: (id: string) => request<TaskInfo>("POST", `${job(id)}/evaluate`),
  evaluation: (id: string) => request<EvaluationView>("GET", `${job(id)}/evaluation`),
  tailor: (id: string, body: TailorBody = {}) =>
    request<TaskInfo>("POST", `${job(id)}/tailor`, body),
  cv: (id: string) => request<CvView>("GET", `${job(id)}/cv`),
  saveCv: (id: string, text: string, expectedSha256: string | null) =>
    request<TaskInfo>("PUT", `${job(id)}/cv`, { text, expectedSha256 }),
  checkCv: (id: string) => request<TaskInfo>("POST", `${job(id)}/cv/check`),
  cvPdfUrl: (id: string, version?: string) =>
    `${job(id)}/cv.pdf${version ? `?v=${version.slice(0, 12)}` : ""}`,
  approve: (id: string, body: ApproveBody = {}) =>
    request<JobDetail>("POST", `${job(id)}/approve`, body),

  // M4: cover letter, with its own checks and approval.
  coverLetter: (id: string) => request<CoverLetterView>("GET", `${job(id)}/cover-letter`),
  writeCoverLetter: (id: string, body: CoverLetterBody) =>
    request<TaskInfo>("POST", `${job(id)}/cover-letter`, body),
  saveCoverLetter: (id: string, text: string, expectedSha256: string | null) =>
    request<TaskInfo>("PUT", `${job(id)}/cover-letter`, { text, expectedSha256 }),
  checkCoverLetter: (id: string) => request<TaskInfo>("POST", `${job(id)}/cover-letter/check`),
  approveCoverLetter: (id: string) => request<JobDetail>("POST", `${job(id)}/cover-letter/approve`),
  coverLetterPdfUrl: (id: string, download = false, version?: string) =>
    `${job(id)}/cover-letter.pdf?${new URLSearchParams({ ...(download ? { download: "1" } : {}), ...(version ? { v: version.slice(0, 12) } : {}) })}`,

  // M4: apply. Hirehound never submits a form; "applied" records what you submitted.
  application: (id: string) => request<ApplicationView>("GET", `${job(id)}/application`),
  applied: (id: string, body: AppliedBody) =>
    request<JobDetail>("POST", `${job(id)}/applied`, body),
  cvDownloadUrl: (id: string) => `${job(id)}/cv.pdf?download=1`,
  confirmationUrl: (id: string) => `${job(id)}/confirmation.png`,
  assistOpen: (id: string, url: string) =>
    request<AssistState>("POST", `${job(id)}/assist/open`, { url }),
  assistFill: (id: string) => request<TaskInfo>("POST", `${job(id)}/assist/fill`),
  assistAnswer: (id: string, body: AssistAnswerBody) =>
    request<AssistState>("POST", `${job(id)}/assist/answer`, body),
  assistClose: (id: string) => request<AssistState>("POST", `${job(id)}/assist/close`),

  // Profile files. Saves send the SHA-256 they were read with; a 409 means "reload first".
  contact: () => request<ProfileFile<Contact>>("GET", "/api/profile/contact"),
  saveContact: (value: unknown, expectedSha256: string | null) =>
    request<ProfileFile<Contact>>("PUT", "/api/profile/contact", { value, expectedSha256 }),
  preferences: () => request<ProfileFile<Preferences>>("GET", "/api/profile/preferences"),
  savePreferences: (value: unknown, expectedSha256: string | null) =>
    request<ProfileFile<Preferences>>("PUT", "/api/profile/preferences", { value, expectedSha256 }),
  answers: () => request<ProfileFile<AnswersFile>>("GET", "/api/profile/answers"),
  saveAnswers: (value: unknown, expectedSha256: string | null) =>
    request<ProfileFile<AnswersFile>>("PUT", "/api/profile/answers", { value, expectedSha256 }),

  bank: () => request<ProfileFile<BankFile>>("GET", "/api/profile/bank"),
  bankOps: (ops: BankOpInput[], expectedSha256: string | null) =>
    request<ProfileFile<BankFile> & { created: string[] }>("POST", "/api/profile/bank/ops", {
      ops,
      expectedSha256,
    }),

  bases: () => request<BaseSummary[]>("GET", "/api/profile/bases"),
  base: (id: string) => request<BaseDetail>("GET", `/api/profile/bases/${encodeURIComponent(id)}`),
  saveBase: (id: string, text: string, expectedSha256: string | null) =>
    request<BaseDetail>("PUT", `/api/profile/bases/${encodeURIComponent(id)}`, {
      text,
      expectedSha256,
    }),
  deleteBase: (id: string) =>
    request<void>("DELETE", `/api/profile/bases/${encodeURIComponent(id)}`),
  draftBase: (spec: BaseSpecInput) => request<TaskInfo>("POST", "/api/profile/bases/draft", spec),
  basePreviewUrl: (id: string, theme?: string, version?: string) =>
    `/api/profile/bases/${encodeURIComponent(id)}/preview?${new URLSearchParams({ ...(theme ? { theme } : {}), ...(version ? { v: version } : {}) })}`,
  basePdfUrl: (id: string, theme?: string, version?: string) =>
    `/api/profile/bases/${encodeURIComponent(id)}/pdf?${new URLSearchParams({ ...(theme ? { theme } : {}), ...(version ? { v: version } : {}) })}`,

  imports: () => request<ImportInfo[]>("GET", "/api/profile/imports"),
  uploadImport: (file: File) =>
    request<ImportInfo>(
      "POST",
      `/api/profile/imports?name=${encodeURIComponent(file.name)}`,
      undefined,
      file,
    ),
  deleteImport: (name: string) =>
    request<void>("DELETE", `/api/profile/imports/${encodeURIComponent(name)}`),

  onboarding: () => request<OnboardingFile>("GET", "/api/onboarding"),
  draftBank: (names?: string[]) =>
    request<TaskInfo>("POST", "/api/onboarding/draft", names ? { names } : {}),
  saveQuestionAnswers: (answers: { id: string; answer?: string; status?: "open" | "skipped" }[]) =>
    request<OnboardingFile>("PUT", "/api/onboarding/answers", { answers }),
  proposeAnswers: () => request<TaskInfo>("POST", "/api/onboarding/answers/propose"),
  resolveQuestions: (ids: string[], status: "applied" | "skipped" | "open") =>
    request<OnboardingFile>("POST", "/api/onboarding/questions/resolve", { ids, status }),

  tasks: () => request<TaskInfo[]>("GET", "/api/tasks"),
  cancelTask: (id: string) => request<void>("POST", `/api/tasks/${encodeURIComponent(id)}/cancel`),

  aiSettings: () => request<AiSettings>("GET", "/api/settings/ai"),
  saveAiSettings: (patch: { engine?: AiSettings["engine"]; model?: string }) =>
    request<AiSettings>("PUT", "/api/settings/ai", patch),
  saveApiKey: (key: string | null) => request<AiSettings>("PUT", "/api/settings/ai/key", { key }),
  testAi: () =>
    request<{ ok: boolean; detail: string; reason?: string }>("POST", "/api/settings/ai/test"),
  pdfStatus: () => request<{ ok: boolean; detail: string }>("GET", "/api/settings/pdf"),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
