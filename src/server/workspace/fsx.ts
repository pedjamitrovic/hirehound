import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizeText } from "../../shared/frontmatter.ts";

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function isNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** UTF-8 text with BOM stripped and LF line endings, or null when the file does not exist. */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return normalizeText(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// Windows: antivirus, indexers and editors briefly lock files, so renames can fail transiently.
const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Writes via a temp file and rename, so readers (the watcher, editors, Claude Code) never see
 * a half-written file. Text is always written with LF line endings.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const content = typeof data === "string" ? data.replace(/\r\n?/g, "\n") : data;
  await writeFile(tmp, content);
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      if (attempt >= 8 || !RETRYABLE.has(errorCode(error) ?? "")) {
        await rm(tmp, { force: true });
        throw error;
      }
      await sleep(25 * attempt);
    }
  }
}

/** Temp files written by writeFileAtomic; the watcher ignores them. */
export function isTempFile(name: string): boolean {
  return /\.tmp-\d+-[0-9a-f]{8}$/.test(name);
}
