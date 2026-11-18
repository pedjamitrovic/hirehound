import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { bankStats } from "../../shared/bank.ts";
import { AnswersFile } from "../../shared/schemas/answers.ts";
import type {
  Diagnostic,
  GitInfo,
  JobSummary,
  ProfileFileState,
  ServerEvent,
  WorkspaceInfo,
} from "../../shared/schemas/api.ts";
import { BankFile } from "../../shared/schemas/bank.ts";
import { Contact } from "../../shared/schemas/contact.ts";
import { Preferences } from "../../shared/schemas/preferences.ts";
import { WorkspaceManifest } from "../../shared/schemas/workspace.ts";
import { APP_VERSION } from "../version.ts";
import { isNotFound, readTextFile } from "./fsx.ts";
import { detectGit, gitDiagnostics } from "./git.ts";
import { type JobRecord, listJobFolders, readJob } from "./job-files.ts";
import { BASES_DIR, MANIFEST_FILE, PROFILE_FILES } from "./layout.ts";
import { parseYaml } from "./yamlfile.ts";

type Profile = {
  revision: string;
  contact: ProfileFileState;
  preferences: ProfileFileState;
  answers: ProfileFileState;
  contactName: string | null;
  bases: string[];
  bank: WorkspaceInfo["profile"]["bank"];
  diagnostics: Diagnostic[];
};

export type Listener = (event: ServerEvent) => void;

/**
 * In-memory index rebuilt from the workspace files. Files are the source of truth; this is
 * only a cache that the watcher keeps current. Bad files become diagnostics, never crashes.
 */
export class WorkspaceIndex {
  readonly root: string;
  watcherMode: WorkspaceInfo["watcher"] = "watching";
  #jobs = new Map<string, JobRecord>();
  #folderDiagnostics: Diagnostic[] = [];
  #profile: Profile = {
    revision: "",
    contact: "missing",
    preferences: "missing",
    answers: "missing",
    contactName: null,
    bases: [],
    bank: { state: "missing", entries: 0, confirmed: 0 },
    diagnostics: [],
  };
  #git: GitInfo | null = null;
  #listeners = new Set<Listener>();
  #lastInfo = "";

  constructor(root: string) {
    this.root = root;
  }

  async load(): Promise<void> {
    this.#git = await detectGit(this.root);
    await this.#loadProfile();
    await this.rescan({ emit: false });
    this.#lastInfo = JSON.stringify(this.info());
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /** Re-reads every job folder whose files changed, and picks up added/removed folders. */
  async rescan(options: { emit?: boolean } = {}): Promise<void> {
    const emit = options.emit ?? true;
    const { ids, diagnostics } = await listJobFolders(this.root);
    this.#folderDiagnostics = diagnostics;
    const present = new Set(ids);
    for (const id of [...this.#jobs.keys()]) {
      if (!present.has(id)) {
        this.#jobs.delete(id);
        if (emit) this.#emit({ type: "job-remove", id });
      }
    }
    for (const id of ids) await this.reloadJob(id, { emit });
    if (emit) this.#emitInfoIfChanged();
  }

  /** Re-reads one job folder; emits only when what the UI shows actually changed. */
  async reloadJob(id: string, options: { emit?: boolean } = {}): Promise<JobRecord | undefined> {
    const emit = options.emit ?? true;
    const previous = this.#jobs.get(id);
    const record = await readJob(this.root, id);
    if (!record) {
      if (previous) {
        this.#jobs.delete(id);
        if (emit) {
          this.#emit({ type: "job-remove", id });
          this.#emitInfoIfChanged();
        }
      }
      return undefined;
    }
    this.#jobs.set(id, record);
    const changed =
      !previous ||
      JSON.stringify(previous.summary) !== JSON.stringify(record.summary) ||
      previous.signature !== record.signature;
    if (emit && changed) {
      this.#emit({ type: "job-upsert", job: record.summary });
      if (!previous) this.#emitInfoIfChanged();
    }
    return record;
  }

  async reloadProfile(): Promise<void> {
    await this.#loadProfile();
    this.#emitInfoIfChanged();
  }

  #emitInfoIfChanged(): void {
    const info = this.info();
    const serialized = JSON.stringify(info);
    if (serialized === this.#lastInfo) return;
    this.#lastInfo = serialized;
    this.#emit({ type: "workspace", info });
  }

  async #loadProfile(): Promise<void> {
    const diagnostics: Diagnostic[] = [];

    const manifestText = await readTextFile(join(this.root, MANIFEST_FILE));
    if (manifestText !== null) {
      diagnostics.push(
        ...parseYaml(manifestText, WorkspaceManifest, { file: MANIFEST_FILE }).diagnostics,
      );
    }

    const load = async <T>(file: string, schema: z.ZodType<T>) => {
      const text = await readTextFile(join(this.root, file));
      if (text === null) return { state: "missing" as const, value: null };
      const parsed = parseYaml(text, schema, { file });
      diagnostics.push(...parsed.diagnostics);
      const state: ProfileFileState = parsed.empty ? "missing" : parsed.value ? "ok" : "invalid";
      return { state, value: parsed.value };
    };

    const contact = await load(PROFILE_FILES.contact, Contact);
    const preferences = await load(PROFILE_FILES.preferences, Preferences);
    const answers = await load(PROFILE_FILES.answers, AnswersFile);
    const bank = await load(PROFILE_FILES.bank, BankFile);
    const stats = bank.value ? bankStats(bank.value) : null;

    let bases: string[] = [];
    try {
      bases = (await readdir(join(this.root, BASES_DIR)))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.slice(0, -3))
        .sort();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    // Changes whenever any profile file changes on disk, so open editors know to reload.
    const revision: string[] = [];
    for (const rel of [
      ...Object.values(PROFILE_FILES),
      ...bases.map((b) => `${BASES_DIR}/${b}.md`),
    ]) {
      try {
        const info = await stat(join(this.root, rel));
        revision.push(`${rel}:${info.mtimeMs}:${info.size}`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    this.#profile = {
      revision: revision.join("|"),
      contact: contact.state,
      preferences: preferences.state,
      answers: answers.state,
      contactName: contact.value?.name ?? null,
      bases,
      bank: { state: bank.state, entries: stats?.total ?? 0, confirmed: stats?.confirmed ?? 0 },
      diagnostics,
    };
  }

  list(): JobSummary[] {
    return [...this.#jobs.values()].map((r) => r.summary);
  }

  get(id: string): JobRecord | undefined {
    return this.#jobs.get(id);
  }

  has(id: string): boolean {
    return this.#jobs.has(id);
  }

  info(): WorkspaceInfo {
    const { diagnostics: profileDiagnostics, ...profile } = this.#profile;
    return {
      path: this.root,
      appVersion: APP_VERSION,
      profile,
      git: this.#git,
      diagnostics: [
        ...gitDiagnostics(this.#git),
        ...profileDiagnostics,
        ...this.#folderDiagnostics,
      ],
      watcher: this.watcherMode,
      jobCount: this.#jobs.size,
    };
  }

  setWatcherMode(mode: WorkspaceInfo["watcher"]): void {
    this.watcherMode = mode;
    this.#emitInfoIfChanged();
  }
}
