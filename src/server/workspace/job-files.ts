import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitFrontmatter } from "../../shared/frontmatter.ts";
import type { Diagnostic, JobSummary, JobUsage } from "../../shared/schemas/api.ts";
import { JOB_ID_PATTERN } from "../../shared/schemas/common.ts";
import { EvaluationFrontmatter } from "../../shared/schemas/evaluation.ts";
import { PostingFrontmatter } from "../../shared/schemas/posting.ts";
import { StatusFile } from "../../shared/schemas/status.ts";
import { VerificationFile } from "../../shared/schemas/verification.ts";
import { computeScore } from "../../shared/score.ts";
import { type GuardContext, transitionOptions } from "../../shared/states.ts";
import { formatPath } from "../../shared/validate.ts";
import { isNotFound, isTempFile, readTextFile } from "./fsx.ts";
import { JOB_FILES, JOBS_DIR, jobDir } from "./layout.ts";
import { parseYaml } from "./yamlfile.ts";

/** Everything the index knows about one job folder. */
export type JobRecord = {
  id: string;
  posting: PostingFrontmatter | null;
  postingBody: string;
  status: StatusFile | null;
  evaluation: EvaluationFrontmatter | null;
  cv: CvState;
  usage: JobUsage;
  files: string[];
  hasRawHtml: boolean;
  diagnostics: Diagnostic[];
  summary: JobSummary;
  /** Cheap change detector for polling mode: mtimes and names of the folder's files. */
  signature: string;
};

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** What the job's files say about its tailored CV. Guards G1 to G3 are derived from this. */
export type CvState = {
  cvSha256: string | null;
  verification: VerificationFile | null;
  /** verification.json describes exactly the current cv.md. */
  current: boolean;
  /** G1: deterministic checks pass and no claim is unsupported. */
  verified: boolean;
  /** SHA-256 of cv.pdf, only when it is the render of the current cv.md. */
  pdfSha256: string | null;
};

export const NO_CV_STATE: CvState = {
  cvSha256: null,
  verification: null,
  current: false,
  verified: false,
  pdfSha256: null,
};

/** The three files of a checked document: its source, its verification and its PDF. */
export type DocFiles = { source: string; verification: string; pdf: string };

export const CV_FILES: DocFiles = {
  source: JOB_FILES.cv,
  verification: JOB_FILES.verification,
  pdf: JOB_FILES.cvPdf,
};

export const COVER_LETTER_FILES: DocFiles = {
  source: JOB_FILES.coverLetter,
  verification: JOB_FILES.coverLetterVerification,
  pdf: JOB_FILES.coverLetterPdf,
};

export function readCvState(
  root: string,
  id: string,
  diagnostics: Diagnostic[] = [],
): Promise<CvState> {
  return readDocState(root, id, CV_FILES, diagnostics);
}

/** Verification state of a CV or cover letter (same rules: G1 and the PDF it was checked with). */
export async function readDocState(
  root: string,
  id: string,
  files: DocFiles,
  diagnostics: Diagnostic[] = [],
): Promise<CvState> {
  const dir = jobDir(root, id);
  const cvText = await readTextFile(join(dir, files.source));
  if (cvText === null) return NO_CV_STATE;
  const cvSha256 = sha256(cvText);

  let verification: VerificationFile | null = null;
  const json = await readTextFile(join(dir, files.verification));
  if (json !== null) {
    const file = `${JOBS_DIR}/${id}/${files.verification}`;
    try {
      const parsed = VerificationFile.safeParse(JSON.parse(json));
      if (parsed.success) verification = parsed.data;
      else {
        const first = parsed.error.issues[0];
        diagnostics.push({
          file,
          severity: "error",
          message: `Invalid${first ? `: ${formatPath(first.path)} ${first.message}` : ""}. Check the CV again to rewrite it.`,
        });
      }
    } catch {
      diagnostics.push({ file, severity: "error", message: "Not valid JSON. Check the CV again." });
    }
  }

  const current = verification?.cv_sha256 === cvSha256;
  const verified =
    current &&
    verification !== null &&
    verification.claims.length > 0 &&
    !verification.checks.some((c) => c.severity === "error") &&
    !verification.claims.some((c) => c.verdict === "unsupported");

  let pdfSha256: string | null = null;
  if (current && verification?.render) {
    try {
      const pdf = await readFile(join(dir, files.pdf));
      const hash = sha256(pdf);
      if (hash === verification.render.pdf_sha256) pdfSha256 = hash;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return { cvSha256, verification, current, verified, pdfSha256 };
}

export function guardContextOf(cv: CvState): GuardContext {
  return { cvVerified: cv.verified, cvPdfSha256: cv.pdfSha256 };
}

/** Guard facts derived from the job's files: verification.json, cv.md and the hash of cv.pdf. */
export async function guardContextFor(root: string, id: string): Promise<GuardContext> {
  return guardContextOf(await readCvState(root, id));
}

async function readEvaluation(
  root: string,
  id: string,
  diagnostics: Diagnostic[],
): Promise<EvaluationFrontmatter | null> {
  const text = await readTextFile(join(jobDir(root, id), JOB_FILES.evaluation));
  if (text === null) return null;
  const file = `${JOBS_DIR}/${id}/${JOB_FILES.evaluation}`;
  const split = splitFrontmatter(text);
  if (split.yaml === null) {
    diagnostics.push({ file, severity: "error", message: "Missing YAML frontmatter", line: 1 });
    return null;
  }
  const parsed = parseYaml(split.yaml, EvaluationFrontmatter, {
    file,
    lineOffset: split.yamlStartLine - 1,
  });
  diagnostics.push(...parsed.diagnostics);
  return parsed.value;
}

/** Sums the job's ai-log.jsonl: what the AI work on this job has cost so far. */
async function readUsage(root: string, id: string): Promise<JobUsage> {
  const usage: JobUsage = { tasks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const text = await readTextFile(join(jobDir(root, id), JOB_FILES.aiLog));
  for (const line of text?.split("\n") ?? []) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      usage.tasks += 1;
      usage.inputTokens += Number(entry.input_tokens) || 0;
      usage.outputTokens += Number(entry.output_tokens) || 0;
      const cost = entry.cost_usd;
      usage.costUsd =
        usage.costUsd === null || typeof cost !== "number" ? null : usage.costUsd + cost;
    } catch {
      // A torn last line while a task is writing: ignore it.
    }
  }
  return usage;
}

export function isJobId(name: string): boolean {
  return JOB_ID_PATTERN.test(name);
}

function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Company and role derived from the folder name, used when posting.md is missing or broken. */
function namesFromId(id: string): { date: string; company: string; title: string } {
  const [date = "", company = "", role = ""] = id.split("_");
  return { date, company: titleCaseSlug(company), title: titleCaseSlug(role.replace(/-\d+$/, "")) };
}

async function folderSignature(dir: string, names: string[]): Promise<string> {
  const parts: string[] = [];
  for (const name of names) {
    try {
      const info = await stat(join(dir, name));
      parts.push(`${name}:${info.mtimeMs}:${info.size}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return parts.join("|");
}

/** Reads a job folder. Returns null when the folder does not exist (deleted). */
export async function readJob(root: string, id: string): Promise<JobRecord | null> {
  const dir = jobDir(root, id);
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const files = entries
    .filter((e) => !e.name.startsWith(".") && !isTempFile(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  const diagnostics: Diagnostic[] = [];
  const rel = (name: string) => `${JOBS_DIR}/${id}/${name}`;

  let posting: PostingFrontmatter | null = null;
  let postingBody = "";
  const postingText = await readTextFile(join(dir, JOB_FILES.posting));
  if (postingText === null) {
    diagnostics.push({
      file: rel(JOB_FILES.posting),
      severity: "error",
      message: "File is missing",
    });
  } else {
    const split = splitFrontmatter(postingText);
    postingBody = split.body;
    if (split.yaml === null) {
      diagnostics.push({
        file: rel(JOB_FILES.posting),
        severity: "error",
        message: "Missing YAML frontmatter (company, title, source, fetched_at, text_sha256)",
        line: 1,
      });
    } else {
      const parsed = parseYaml(split.yaml, PostingFrontmatter, {
        file: rel(JOB_FILES.posting),
        lineOffset: split.yamlStartLine - 1,
      });
      posting = parsed.value;
      diagnostics.push(...parsed.diagnostics);
      if (parsed.empty) {
        diagnostics.push({
          file: rel(JOB_FILES.posting),
          severity: "error",
          message: "Frontmatter is empty",
        });
      }
    }
  }

  let status: StatusFile | null = null;
  const statusText = await readTextFile(join(dir, JOB_FILES.status));
  if (statusText === null) {
    diagnostics.push({
      file: rel(JOB_FILES.status),
      severity: "error",
      message: "File is missing",
    });
  } else {
    const parsed = parseYaml(statusText, StatusFile, { file: rel(JOB_FILES.status) });
    status = parsed.value;
    diagnostics.push(...parsed.diagnostics);
    if (parsed.empty) {
      diagnostics.push({
        file: rel(JOB_FILES.status),
        severity: "error",
        message: "File is empty",
      });
    }
    const last = status?.history.at(-1);
    if (status && last && last.to !== status.state) {
      diagnostics.push({
        file: rel(JOB_FILES.status),
        severity: "warning",
        message: `state is "${status.state}" but the last history entry moved to "${last.to}". The next move will be recorded from "${status.state}".`,
      });
    }
  }

  const evaluation = await readEvaluation(root, id, diagnostics);
  // The score is always recomputed from the matrix, so a hand edit of the matrix is honoured.
  const score = evaluation ? computeScore(evaluation.fit.requirements) : null;
  const cv = await readCvState(root, id, diagnostics);
  const usage = await readUsage(root, id);

  const fallback = namesFromId(id);
  const firstEvent = status?.history[0];
  const lastEvent = status?.history.at(-1);
  const lastNote = status?.notes.at(-1);
  const addedAt = firstEvent?.at ?? posting?.fetched_at ?? `${fallback.date}T00:00:00Z`;
  const updatedCandidates = [lastEvent?.at, lastNote?.at, addedAt].filter(
    (v): v is string => typeof v === "string",
  );
  const updatedAt = updatedCandidates.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );

  const summary: JobSummary = {
    id,
    company: posting?.company ?? fallback.company,
    title: posting?.title ?? fallback.title,
    state: status?.state ?? "found",
    source: posting?.source ?? null,
    url: posting?.url ?? null,
    location: posting?.location ?? null,
    workplace: posting?.workplace ?? "unknown",
    salary: posting?.salary ?? null,
    score: score?.score ?? null,
    band: score?.band ?? null,
    recommendation: evaluation?.recommendation.verdict ?? null,
    base: status?.base ?? null,
    tags: status?.tags ?? [],
    addedAt,
    updatedAt,
    appliedExternally: status?.application?.method === "external",
    noteCount: status?.notes.length ?? 0,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    transitions: status ? transitionOptions(status, guardContextOf(cv)) : [],
  };

  return {
    id,
    posting,
    postingBody,
    status,
    evaluation,
    cv,
    usage,
    files,
    hasRawHtml: files.includes(JOB_FILES.postingHtml),
    diagnostics,
    summary,
    signature: await folderSignature(
      dir,
      files.filter((f) => !f.endsWith("/")),
    ),
  };
}

/** Names of job folders, plus diagnostics for folders that do not follow the naming rule. */
export async function listJobFolders(
  root: string,
): Promise<{ ids: string[]; diagnostics: Diagnostic[] }> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(join(root, JOBS_DIR), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { ids: [], diagnostics: [] };
    throw error;
  }
  const ids: string[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (isJobId(entry.name)) ids.push(entry.name);
    else {
      diagnostics.push({
        file: `${JOBS_DIR}/${entry.name}`,
        severity: "warning",
        message:
          "Ignored: job folders are named <YYYY-MM-DD>_<company>_<role> using lowercase letters, digits and hyphens.",
      });
    }
  }
  return { ids: ids.sort(), diagnostics };
}
