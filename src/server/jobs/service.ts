import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { joinFrontmatter, toYaml } from "../../shared/frontmatter.ts";
import type { BulkTransitionResult, CreateJobRequest } from "../../shared/schemas/api.ts";
import type { PostingFrontmatter } from "../../shared/schemas/posting.ts";
import { type Person, type StatusEvent, StatusFile } from "../../shared/schemas/status.ts";
import { jobIdFor } from "../../shared/slug.ts";
import { applyTransition, checkTransition, type TransitionRequest } from "../../shared/states.ts";
import { localIsoDate, localIsoDateTime } from "../../shared/time.ts";
import type { AppContext } from "../app-context.ts";
import { HttpError } from "../http/router.ts";
import { errorCode, readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import { guardContextFor, type JobRecord } from "../workspace/job-files.ts";
import { JOB_FILES, JOBS_DIR, jobDir } from "../workspace/layout.ts";
import { parseYaml } from "../workspace/yamlfile.ts";
import { normalizePostingText, type Snapshot, textSha256 } from "./snapshot.ts";

type CreateInput = z.output<typeof CreateJobRequest>;

/**
 * All writes to job folders go through here. Each job has its own queue so concurrent requests
 * (double clicks, bulk moves, two tabs) never interleave a read-modify-write of status.yaml.
 */
export class JobService {
  readonly #app: Pick<AppContext, "root" | "index">;
  #queues = new Map<string, Promise<unknown>>();

  constructor(app: Pick<AppContext, "root" | "index">) {
    this.#app = app;
  }

  #withLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => {});
    this.#queues.set(id, settled);
    void settled.then(() => {
      if (this.#queues.get(id) === settled) this.#queues.delete(id);
    });
    return run;
  }

  async #reload(id: string): Promise<JobRecord> {
    const record = await this.#app.index.reloadJob(id);
    if (!record) throw new HttpError(404, "job-not-found", `Job ${id} disappeared while saving`);
    return record;
  }

  async #readStatus(id: string): Promise<StatusFile> {
    if (!this.#app.index.has(id)) throw new HttpError(404, "job-not-found", `No job with id ${id}`);
    const file = `${JOBS_DIR}/${id}/${JOB_FILES.status}`;
    const text = await readTextFile(join(jobDir(this.#app.root, id), JOB_FILES.status));
    if (text === null) throw new HttpError(409, "status-missing", `${file} is missing.`);
    const parsed = parseYaml(text, StatusFile, { file });
    if (!parsed.value) {
      const first = parsed.diagnostics[0];
      throw new HttpError(
        409,
        "status-invalid",
        `${file} has errors${first ? ` (${first.message})` : ""}. Fix the file first.`,
      );
    }
    return parsed.value;
  }

  async #writeStatus(id: string, status: StatusFile): Promise<void> {
    await writeFileAtomic(join(jobDir(this.#app.root, id), JOB_FILES.status), toYaml(status));
  }

  async #updateStatus(id: string, update: (status: StatusFile) => StatusFile): Promise<JobRecord> {
    return this.#withLock(id, async () => {
      const next = update(await this.#readStatus(id));
      await this.#writeStatus(id, next);
      return this.#reload(id);
    });
  }

  async create(input: CreateInput, snapshot?: Snapshot): Promise<JobRecord> {
    const now = new Date();
    const jobsRoot = join(this.#app.root, JOBS_DIR);
    await mkdir(jobsRoot, { recursive: true });

    let id = "";
    for (let attempt = 1; ; attempt++) {
      id = jobIdFor(localIsoDate(now), input.company, input.title, attempt);
      try {
        await mkdir(jobDir(this.#app.root, id));
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || attempt >= 99) throw error;
      }
    }

    const at = localIsoDateTime(now);
    const body = normalizePostingText(input.kind === "text" ? input.text : (snapshot?.text ?? ""));
    const extracted = snapshot?.extracted;
    const frontmatter: PostingFrontmatter = {
      version: 1,
      company: input.company,
      title: input.title,
      ...(input.kind === "url" && snapshot
        ? { url: snapshot.finalUrl }
        : input.kind === "text" && input.url
          ? { url: input.url }
          : {}),
      source: input.kind === "url" ? "manual-url" : "manual-text",
      ...(extracted?.sourceRef ? { source_ref: extracted.sourceRef } : {}),
      ...(input.location ? { location: input.location } : {}),
      workplace: input.workplace,
      employment_type: input.employmentType,
      ...(extracted?.salary ? { salary: extracted.salary } : {}),
      ...(extracted?.postedAt ? { posted_at: extracted.postedAt } : {}),
      ...(extracted?.validThrough ? { valid_through: extracted.validThrough } : {}),
      fetched_at: snapshot?.fetchedAt ?? at,
      text_sha256: textSha256(body),
    };
    const status: StatusFile = {
      version: 1,
      state: "found",
      history: [{ at, from: null, to: "found", by: "user" }],
      notes: [],
      contacts: [],
      tags: [],
    };

    const dir = jobDir(this.#app.root, id);
    try {
      if (snapshot) await writeFileAtomic(join(dir, JOB_FILES.postingHtml), snapshot.html);
      await writeFileAtomic(join(dir, JOB_FILES.posting), joinFrontmatter(frontmatter, body));
      await writeFileAtomic(join(dir, JOB_FILES.status), toYaml(status));
    } catch (error) {
      // Never leave a half-created job behind.
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return this.#reload(id);
  }

  async transition(
    id: string,
    req: TransitionRequest,
    by: StatusEvent["by"] = "user",
  ): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => {
      const check = checkTransition(status, req, guardContextFor(this.#app.root, id));
      if (!check.ok) {
        throw new HttpError(
          check.code === "reason-required" ? 400 : 409,
          check.code,
          check.message,
        );
      }
      return applyTransition(status, req, { at: localIsoDateTime(), by });
    });
  }

  async bulkTransition(ids: string[], req: TransitionRequest): Promise<BulkTransitionResult> {
    const results = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        try {
          await this.transition(id, req);
          return { id, ok: true };
        } catch (error) {
          return { id, ok: false, message: (error as Error).message };
        }
      }),
    );
    return { results };
  }

  addNote(id: string, text: string): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => ({
      ...status,
      notes: [...status.notes, { at: localIsoDateTime(), text: text.trim() }],
    }));
  }

  /** `at` must match the note's timestamp, so a stale UI never deletes the wrong note. */
  deleteNote(id: string, index: number, at: string): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => {
      if (status.notes[index]?.at !== at) {
        throw new HttpError(
          409,
          "stale",
          "That note changed in the meantime. Reload and try again.",
        );
      }
      return { ...status, notes: status.notes.filter((_, i) => i !== index) };
    });
  }

  addContact(id: string, person: Person): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => ({
      ...status,
      contacts: [...status.contacts, person],
    }));
  }

  deleteContact(id: string, index: number, name: string): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => {
      if (status.contacts[index]?.name !== name) {
        throw new HttpError(
          409,
          "stale",
          "That contact changed in the meantime. Reload and try again.",
        );
      }
      return { ...status, contacts: status.contacts.filter((_, i) => i !== index) };
    });
  }
}
