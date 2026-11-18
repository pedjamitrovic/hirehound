import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Diagnostic, GitInfo } from "../../shared/schemas/api.ts";
import { isNotFound } from "./fsx.ts";

async function findGitRoot(start: string): Promise<{ root: string; gitDir: string } | null> {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".git");
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return { root: dir, gitDir: candidate };
      // Worktrees and submodules: ".git" is a file containing "gitdir: <path>".
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(candidate, "utf8"));
      if (pointer?.[1]) return { root: dir, gitDir: resolve(dir, pointer[1].trim()) };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Remote names and URLs from a git config file. */
export function parseRemotes(config: string): { name: string; url: string }[] {
  const remotes: { name: string; url: string }[] = [];
  let current: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (section?.[1]) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = null;
      continue;
    }
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (current && url?.[1]) remotes.push({ name: current, url: url[1] });
  }
  return remotes;
}

async function isHirehoundRepo(root: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "hirehound";
  } catch {
    return false;
  }
}

/** Git repository that contains the workspace, if any (PRD 10: warn about public repos). */
export async function detectGit(workspace: string): Promise<GitInfo | null> {
  const found = await findGitRoot(workspace);
  if (!found) return null;
  let remotes: GitInfo["remotes"] = [];
  try {
    // For worktrees the remotes live in the common dir; fall back gracefully.
    const commonDir = await readFile(join(found.gitDir, "commondir"), "utf8").then(
      (text) => resolve(found.gitDir, text.trim()),
      () => found.gitDir,
    );
    remotes = parseRemotes(await readFile(join(commonDir, "config"), "utf8"));
  } catch {
    remotes = [];
  }
  return { root: found.root, remotes, insideToolRepo: await isHirehoundRepo(found.root) };
}

export function gitDiagnostics(git: GitInfo | null): Diagnostic[] {
  if (!git) return [];
  if (git.insideToolRepo) {
    return [
      {
        file: ".",
        severity: "error",
        message:
          "This workspace is inside the Hirehound source repository, which is public. Move it outside the repo so your personal data is never committed there.",
      },
    ];
  }
  if (git.remotes.length === 0) return [];
  const list = git.remotes.map((r) => `${r.name} (${r.url})`).join(", ");
  return [
    {
      file: ".",
      severity: "warning",
      message: `This workspace is in a git repository with remote ${list}. Make sure that repository is private.`,
    },
  ];
}
