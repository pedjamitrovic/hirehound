import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitFrontmatter } from "../../shared/frontmatter.ts";
import type { Diagnostic, JobSummary } from "../../shared/schemas/api.ts";
import { JOB_ID_PATTERN } from "../../shared/schemas/common.ts";
import { PostingFrontmatter } from "../../shared/schemas/posting.ts";
import { StatusFile } from "../../shared/schemas/status.ts";
import { isNotFound, isTempFile, readTextFile } from "./fsx.ts";
import { JOB_FILES, JOBS_DIR, jobDir } from "./layout.ts";
import { parseYaml } from "./yamlfile.ts";

/** Everything the index knows about one job folder. */
export type JobRecord = {
  id: string;
  posting: PostingFrontmatter | null;
  postingBody: string;
  status: StatusFile | null;
  files: string[];
  hasRawHtml: boolean;
  diagnostics: Diagnostic[];
  summary: JobSummary;
  /** Cheap change detector for polling mode: mtimes and names of the folder's files. */
  signature: string;
};

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
    score: null,
    band: null,
    base: status?.base ?? null,
    tags: status?.tags ?? [],
    addedAt,
    updatedAt,
    appliedExternally: status?.application?.method === "external",
    noteCount: status?.notes.length ?? 0,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
  };

  return {
    id,
    posting,
    postingBody,
    status,
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
