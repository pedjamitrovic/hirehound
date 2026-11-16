import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { toYaml } from "../../shared/frontmatter.ts";
import { localIsoDateTime } from "../../shared/time.ts";
import { isNotFound, writeFileAtomic } from "./fsx.ts";
import { MANIFEST_FILE, PROFILE_FILES, WORKSPACE_DIRS } from "./layout.ts";
import {
  ANSWERS_TEMPLATE,
  CONTACT_TEMPLATE,
  PREFERENCES_TEMPLATE,
  WORKSPACE_README,
} from "./templates.ts";

export type WorkspaceKind = "workspace" | "missing" | "empty" | "other";

/** What is at `root`: a workspace, nothing, an empty folder, or some unrelated folder. */
export async function inspectWorkspace(root: string): Promise<WorkspaceKind> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return "other";
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw error;
  }
  const entries = await readdir(root);
  if (entries.includes(MANIFEST_FILE)) return "workspace";
  // A workspace created by hand (or an older version) without the manifest.
  if (entries.includes("jobs") && entries.includes("profile")) return "workspace";
  return entries.filter((e) => !e.startsWith(".")).length === 0 ? "empty" : "other";
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await writeFileAtomic(path, content);
  return true;
}

/**
 * Creates the workspace layout and starter files. Idempotent and non-destructive:
 * it only ever adds what is missing and never overwrites a file.
 */
export async function initWorkspace(root: string): Promise<{ created: string[] }> {
  const created: string[] = [];
  await mkdir(root, { recursive: true });
  for (const dir of WORKSPACE_DIRS) {
    await mkdir(join(root, dir), { recursive: true });
  }
  const files: [string, string][] = [
    [MANIFEST_FILE, toYaml({ version: 1, created_at: localIsoDateTime() })],
    ["README.md", WORKSPACE_README],
    [PROFILE_FILES.contact, CONTACT_TEMPLATE],
    [PROFILE_FILES.preferences, PREFERENCES_TEMPLATE],
    [PROFILE_FILES.answers, ANSWERS_TEMPLATE],
  ];
  for (const [relative, content] of files) {
    if (await writeIfMissing(join(root, relative), content)) created.push(relative);
  }
  return { created };
}
