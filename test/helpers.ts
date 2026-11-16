import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/server/workspace/fsx.ts";
import { initWorkspace } from "../src/server/workspace/init.ts";
import { jobDir } from "../src/server/workspace/layout.ts";
import { joinFrontmatter, toYaml } from "../src/shared/frontmatter.ts";
import type { PostingFrontmatter } from "../src/shared/schemas/posting.ts";
import type { StatusFile } from "../src/shared/schemas/status.ts";

export const AT = "2026-11-16T10:42:00+01:00";

export async function tempDir(prefix = "hirehound-test-"): Promise<{
  path: string;
  cleanup(): Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export async function tempWorkspace() {
  const dir = await tempDir();
  const root = join(dir.path, "workspace");
  await initWorkspace(root);
  return { root, cleanup: dir.cleanup };
}

export function samplePosting(overrides: Partial<PostingFrontmatter> = {}): PostingFrontmatter {
  return {
    version: 1,
    company: "Acme",
    title: "Engineering Manager",
    url: "https://jobs.example.com/acme/1",
    source: "manual-url",
    workplace: "remote",
    employment_type: "full-time",
    fetched_at: AT,
    text_sha256: "0".repeat(64),
    ...overrides,
  };
}

export function sampleStatus(overrides: Partial<StatusFile> = {}): StatusFile {
  return {
    version: 1,
    state: "found",
    history: [{ at: AT, from: null, to: "found", by: "user" }],
    notes: [],
    contacts: [],
    tags: [],
    ...overrides,
  };
}

/** Writes a job folder. Pass raw strings to write deliberately broken files. */
export async function writeJob(
  root: string,
  id: string,
  files: {
    posting?: PostingFrontmatter | string | null;
    status?: StatusFile | string | null;
    body?: string;
  } = {},
): Promise<void> {
  const dir = jobDir(root, id);
  const posting = files.posting === undefined ? samplePosting() : files.posting;
  const status = files.status === undefined ? sampleStatus() : files.status;
  if (posting !== null) {
    await writeFileAtomic(
      join(dir, "posting.md"),
      typeof posting === "string"
        ? posting
        : joinFrontmatter(posting, files.body ?? "About the role\n"),
    );
  }
  if (status !== null) {
    await writeFileAtomic(
      join(dir, "status.yaml"),
      typeof status === "string" ? status : toYaml(status),
    );
  }
}

/** Polls until `check` passes or the timeout expires (file watching is asynchronous). */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
