import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { z } from "zod";
import { entryLabel, indexBank } from "../../shared/bank.ts";
import { checkEvidence, cvEvidenceIds } from "../../shared/cv/evidence.ts";
import { parseCv } from "../../shared/cv/parse.ts";
import { joinFrontmatter } from "../../shared/frontmatter.ts";
import type {
  BaseDetail,
  BaseSummary,
  CvIssue,
  ImportInfo,
  ProfileFile,
} from "../../shared/schemas/api.ts";
import { BankFile } from "../../shared/schemas/bank.ts";
import { BaseId } from "../../shared/schemas/common.ts";
import { Contact } from "../../shared/schemas/contact.ts";
import { BaseCvFrontmatter, type CvTheme } from "../../shared/schemas/cv.ts";
import { OnboardingFile } from "../../shared/schemas/onboarding.ts";
import { Preferences } from "../../shared/schemas/preferences.ts";
import { slugify } from "../../shared/slug.ts";
import { localIsoDate } from "../../shared/time.ts";
import { formatPath } from "../../shared/validate.ts";
import { HttpError } from "../http/router.ts";
import { ImportError } from "../import/errors.ts";
import { extractSource } from "../import/extract.ts";
import { cvDocumentHtml, type Paper, themeCss } from "../pdf/document.ts";
import type { PdfRenderer } from "../pdf/render.ts";
import { isNotFound, readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import { BASES_DIR, IMPORTS_DIR, PROFILE_FILES } from "../workspace/layout.ts";
import { updateYamlText } from "../workspace/yaml-edit.ts";
import { parseYaml } from "../workspace/yamlfile.ts";
import { applyBankOps, type BankOp } from "./bank-ops.ts";

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

const HEADERS: Record<string, string> = {
  [PROFILE_FILES.contact]: "# Contact details for the CV header. Edited in Hirehound (Profile).\n",
  [PROFILE_FILES.preferences]: "# What you are looking for. Edited in Hirehound (Profile).\n",
  [PROFILE_FILES.answers]: "# Reusable answers for application forms.\n",
  [PROFILE_FILES.onboarding]: "# Onboarding state: open questions about your experience bank.\n",
};

type ProfileContext = { root: string; pdf: PdfRenderer };

/**
 * Reads and writes everything under profile/. Saves use optimistic concurrency: the client sends
 * the SHA-256 of the version it edited, and a file changed meanwhile (by an editor, Claude Code or
 * another tab) is never silently overwritten.
 */
export class ProfileService {
  readonly #ctx: ProfileContext;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: ProfileContext) {
    this.#ctx = ctx;
  }

  get root(): string {
    return this.#ctx.root;
  }

  /** Serialises writes to profile files. */
  #locked<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  #path(rel: string): string {
    return join(this.#ctx.root, ...rel.split("/"));
  }

  async readYaml<T>(rel: string, schema: z.ZodType<T>): Promise<ProfileFile<T>> {
    const text = await readTextFile(this.#path(rel));
    if (text === null) return { value: null, empty: true, sha256: null, diagnostics: [] };
    const parsed = parseYaml(text, schema, { file: rel });
    return {
      value: parsed.value,
      empty: parsed.empty,
      sha256: sha256(text),
      diagnostics: parsed.diagnostics,
    };
  }

  #checkVersion(text: string | null, expected: string | null): void {
    const current = text === null ? null : sha256(text);
    if (current !== expected) {
      throw new HttpError(
        409,
        "changed-on-disk",
        "This file changed since you opened it (in another tab or an editor). Reload to see the latest version.",
      );
    }
  }

  /** Validates and saves a profile YAML file, keeping comments and key order where possible. */
  writeYaml<T>(
    rel: string,
    schema: z.ZodType<T>,
    value: unknown,
    expectedSha256: string | null,
  ): Promise<ProfileFile<T>> {
    return this.#locked(async () => {
      const result = schema.safeParse(value);
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({
          path: formatPath(i.path),
          message: i.message,
        }));
        throw new HttpError(
          400,
          "invalid-request",
          issues[0] ? `${issues[0].path}: ${issues[0].message}` : "Invalid",
          issues,
        );
      }
      const text = await readTextFile(this.#path(rel));
      this.#checkVersion(text, expectedSha256);
      await writeFileAtomic(this.#path(rel), updateYamlText(text, value, HEADERS[rel] ?? ""));
      return this.readYaml(rel, schema);
    });
  }

  contact(): Promise<ProfileFile<Contact>> {
    return this.readYaml(PROFILE_FILES.contact, Contact);
  }

  preferences(): Promise<ProfileFile<Preferences>> {
    return this.readYaml(PROFILE_FILES.preferences, Preferences);
  }

  // ---------- Experience bank ----------

  async bank(): Promise<ProfileFile<BankFile>> {
    return this.readYaml(PROFILE_FILES.bank, BankFile);
  }

  applyBankOps(
    ops: BankOp[],
    expectedSha256: string | null,
  ): Promise<ProfileFile<BankFile> & { created: string[] }> {
    return this.#locked(async () => {
      const path = this.#path(PROFILE_FILES.bank);
      const text = await readTextFile(path);
      this.#checkVersion(text, expectedSha256);
      const result = applyBankOps(text, ops);
      await writeFileAtomic(path, result.text);
      return { ...(await this.bank()), created: result.created };
    });
  }

  /** Writes new bank text produced by a task (used by onboarding drafts). */
  writeBankText(compute: (current: string | null) => string): Promise<void> {
    return this.#locked(async () => {
      const path = this.#path(PROFILE_FILES.bank);
      await writeFileAtomic(path, compute(await readTextFile(path)));
    });
  }

  // ---------- Onboarding state ----------

  async onboarding(): Promise<OnboardingFile> {
    const file = await this.readYaml(PROFILE_FILES.onboarding, OnboardingFile);
    return file.value ?? OnboardingFile.parse({});
  }

  updateOnboarding(update: (current: OnboardingFile) => OnboardingFile): Promise<OnboardingFile> {
    return this.#locked(async () => {
      const path = this.#path(PROFILE_FILES.onboarding);
      const text = await readTextFile(path);
      const current =
        (text ? parseYaml(text, OnboardingFile, { file: PROFILE_FILES.onboarding }).value : null) ??
        OnboardingFile.parse({});
      const next = OnboardingFile.parse(update(current));
      await writeFileAtomic(path, updateYamlText(text, next, HEADERS[PROFILE_FILES.onboarding]));
      return next;
    });
  }

  // ---------- Imported source files ----------

  async listImports(): Promise<ImportInfo[]> {
    const dir = this.#path(IMPORTS_DIR);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const out: ImportInfo[] = [];
    for (const name of names) {
      const data = await readFile(join(dir, name));
      try {
        const source = extractSource(name, data);
        out.push({
          name,
          kind: source.kind,
          origin: source.kind === "pdf" ? "pdf" : source.origin,
          size: data.byteLength,
          chars: source.kind === "text" ? source.text.length : null,
          error: null,
        });
      } catch (error) {
        out.push({
          name,
          kind: "unsupported",
          origin: extname(name).slice(1),
          size: data.byteLength,
          chars: null,
          error: (error as Error).message,
        });
      }
    }
    return out;
  }

  /** Stores an uploaded file in profile/imports after checking it can be read. */
  addImport(fileName: string, data: Uint8Array): Promise<ImportInfo> {
    return this.#locked(async () => {
      let source: ReturnType<typeof extractSource>;
      try {
        source = extractSource(fileName, data);
      } catch (error) {
        if (error instanceof ImportError)
          throw new HttpError(400, `import-${error.code}`, error.message);
        throw error;
      }
      const dir = this.#path(IMPORTS_DIR);
      await mkdir(dir, { recursive: true });
      const hash = sha256(data);
      const existing = await readdir(dir);
      for (const name of existing) {
        if (sha256(await readFile(join(dir, name))) === hash) {
          return (await this.listImports()).find((i) => i.name === name) as ImportInfo;
        }
      }
      const ext = extname(fileName).toLowerCase();
      const stem = slugify(fileName.slice(0, fileName.length - ext.length), 40);
      let name = `${localIsoDate()}_${stem}${ext}`;
      for (let n = 2; existing.includes(name); n++) name = `${localIsoDate()}_${stem}-${n}${ext}`;
      await writeFileAtomic(join(dir, name), data);
      return {
        name,
        kind: source.kind,
        origin: source.kind === "pdf" ? "pdf" : source.origin,
        size: data.byteLength,
        chars: source.kind === "text" ? source.text.length : null,
        error: null,
      };
    });
  }

  async deleteImport(name: string): Promise<void> {
    if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, "invalid-name", "Invalid file name");
    await rm(join(this.#path(IMPORTS_DIR), name), { force: true });
  }

  async readImport(name: string): Promise<Uint8Array> {
    if (!/^[\w.-]+$/.test(name)) throw new HttpError(400, "invalid-name", "Invalid file name");
    return readFile(join(this.#path(IMPORTS_DIR), name));
  }

  // ---------- Base CVs ----------

  #basePath(id: string): string {
    if (!BaseId.safeParse(id).success)
      throw new HttpError(400, "invalid-base", `Invalid base CV id ${id}`);
    return join(this.#path(BASES_DIR), `${id}.md`);
  }

  async #analyseBase(id: string, text: string, updatedAt: string): Promise<BaseDetail> {
    const { doc, issues } = parseCv(text);
    const all: CvIssue[] = [...issues];
    const front = BaseCvFrontmatter.safeParse({ id, ...doc.frontmatter });
    if (!front.success) {
      for (const issue of front.error.issues) {
        all.push({
          line: 1,
          col: 1,
          severity: "error",
          message: `frontmatter ${formatPath(issue.path)}: ${issue.message}`,
        });
      }
    }
    const bank = (await this.bank()).value;
    const index = bank ? indexBank(bank) : new Map();
    all.push(...checkEvidence(doc, new Set(index.keys()), "base"));
    const evidence = cvEvidenceIds(doc).map((evId) => {
      const entry = index.get(evId);
      return {
        id: evId,
        label: entry ? entryLabel(entry) : "Not in the experience bank",
        confirmed: Boolean(entry?.entry.confirmed),
      };
    });
    for (const e of evidence) {
      if (index.has(e.id) && !e.confirmed) {
        all.push({
          line: 1,
          col: 1,
          severity: "warning",
          message: `${e.id} is not confirmed in the experience bank yet`,
        });
      }
    }
    const fm = front.success ? front.data : null;
    const raw = doc.frontmatter as Record<string, unknown>;
    return {
      summary: {
        id,
        label: fm?.label ?? (typeof raw.label === "string" ? raw.label : id),
        track: fm?.track ?? null,
        theme: fm?.theme ?? "classic",
        headline: fm?.headline ?? null,
        errors: all.filter((i) => i.severity === "error").length,
        warnings: all.filter((i) => i.severity === "warning").length,
        updatedAt,
      },
      text,
      sha256: sha256(text),
      issues: all.sort((a, b) => a.line - b.line),
      evidence,
    };
  }

  async listBases(): Promise<BaseSummary[]> {
    const dir = this.#path(BASES_DIR);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const out: BaseSummary[] = [];
    for (const name of names) {
      const id = name.slice(0, -3);
      if (!BaseId.safeParse(id).success) continue;
      out.push((await this.readBase(id)).summary);
    }
    return out;
  }

  async readBase(id: string): Promise<BaseDetail> {
    const path = this.#basePath(id);
    const text = await readTextFile(path);
    if (text === null) throw new HttpError(404, "base-not-found", `No base CV ${id}`);
    const info = await stat(path);
    return this.#analyseBase(id, text, info.mtime.toISOString());
  }

  writeBase(id: string, text: string, expectedSha256: string | null): Promise<BaseDetail> {
    return this.#locked(async () => {
      const path = this.#basePath(id);
      this.#checkVersion(await readTextFile(path), expectedSha256);
      await writeFileAtomic(path, text.replace(/\r\n?/g, "\n"));
      return this.readBase(id);
    });
  }

  /** Creates a new base CV file with a unique id derived from the label. */
  createBase(
    label: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<BaseDetail> {
    return this.#locked(async () => {
      const dir = this.#path(BASES_DIR);
      await mkdir(dir, { recursive: true });
      const stem = slugify(label, 28);
      let id = stem;
      for (let n = 2; await readTextFile(join(dir, `${id}.md`)); n++) id = `${stem}-${n}`;
      await writeFileAtomic(join(dir, `${id}.md`), joinFrontmatter({ id, ...frontmatter }, body));
      return this.readBase(id);
    });
  }

  async deleteBase(id: string): Promise<void> {
    await rm(this.#basePath(id), { force: true });
  }

  async baseHtml(id: string, themeOverride?: CvTheme): Promise<string> {
    const detail = await this.readBase(id);
    const { doc } = parseCv(detail.text);
    const contact = (await this.contact()).value;
    const prefs = (await this.preferences()).value;
    const paper: Paper = prefs?.cv.paper ?? "a4";
    return cvDocumentHtml({
      doc,
      contact,
      headline: detail.summary.headline ?? undefined,
      css: await themeCss(this.#ctx.root, themeOverride ?? detail.summary.theme),
      paper,
    });
  }

  async basePdf(id: string, themeOverride?: CvTheme): Promise<{ pdf: Buffer; pages: number }> {
    const prefs = (await this.preferences()).value;
    return this.#ctx.pdf.render(await this.baseHtml(id, themeOverride), prefs?.cv.paper ?? "a4");
  }
}
