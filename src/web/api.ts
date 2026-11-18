import type {
  ApiErrorBody,
  BulkTransitionBody,
  BulkTransitionResult,
  ContactBody,
  CreateJobRequest,
  JobDetail,
  JobSummary,
  NoteBody,
  PostingDraft,
  TransitionBody,
  WorkspaceInfo,
} from "../shared/schemas/api.ts";

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
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
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
