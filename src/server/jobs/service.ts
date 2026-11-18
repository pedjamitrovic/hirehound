import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { joinFrontmatter, splitFrontmatter, toYaml } from "../../shared/frontmatter.ts";
import type { BulkTransitionResult, CreateJobRequest } from "../../shared/schemas/api.ts";
import { PostingFrontmatter } from "../../shared/schemas/posting.ts";
import { type Person, type StatusEvent, StatusFile } from "../../shared/schemas/status.ts";
import { jobIdFor } from "../../shared/slug.ts";
import { applyTransition, checkTransition, type TransitionRequest } from "../../shared/states.ts";
import { localIsoDate, localIsoDateTime } from "../../shared/time.ts";
import type { AppContext } from "../app-context.ts";
import type { DiscoveredPosting } from "../discovery/ats.ts";
import { HttpError } from "../http/router.ts";
import { errorCode, readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import {
  COVER_LETTER_FILES,
  guardContextFor,
  type JobRecord,
  readDocState,
} from "../workspace/job-files.ts";
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

  async #updateStatus(
    id: string,
    update: (status: StatusFile) => StatusFile | Promise<StatusFile>,
  ): Promise<JobRecord> {
    return this.#withLock(id, async () => {
      const current = await this.#readStatus(id);
      const next = await update(current);
      // Returning the same object means "no change": nothing is written.
      if (next !== current) await this.#writeStatus(id, next);
      return this.#reload(id);
    });
  }

  /** Runs `task` while holding the job's lock, so no status change interleaves with it. */
  locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    return this.#withLock(id, task);
  }

  /** Creates the job's folder under a fresh id; the id never changes afterwards. */
  async #allocate(company: string, title: string, now: Date): Promise<string> {
    await mkdir(join(this.#app.root, JOBS_DIR), { recursive: true });
    for (let attempt = 1; ; attempt++) {
      const id = jobIdFor(localIsoDate(now), company, title, attempt);
      try {
        await mkdir(jobDir(this.#app.root, id));
        return id;
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || attempt >= 99) throw error;
      }
    }
  }

  async #writeNew(
    id: string,
    files: { posting: PostingFrontmatter; body: string; status: StatusFile; html?: string },
  ): Promise<JobRecord> {
    const dir = jobDir(this.#app.root, id);
    try {
      if (files.html) await writeFileAtomic(join(dir, JOB_FILES.postingHtml), files.html);
      await writeFileAtomic(
        join(dir, JOB_FILES.posting),
        joinFrontmatter(files.posting, files.body),
      );
      await writeFileAtomic(join(dir, JOB_FILES.status), toYaml(files.status));
    } catch (error) {
      // Never leave a half-created job behind.
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return this.#reload(id);
  }

  /** M5: a Found job from a job board or an alert. Recorded as added by the system. */
  async createDiscovered(
    posting: DiscoveredPosting,
    options: {
      repostOf?: string | undefined;
      html?: string | undefined;
      text?: string | undefined;
    } = {},
  ): Promise<JobRecord> {
    const now = new Date();
    const id = await this.#allocate(posting.company, posting.title, now);
    const at = localIsoDateTime(now);
    const body = normalizePostingText(options.text ?? posting.text);
    const frontmatter: PostingFrontmatter = {
      version: 1,
      company: posting.company,
      title: posting.title,
      url: posting.url,
      source: posting.provider,
      source_ref: posting.sourceRef,
      ...(posting.location ? { location: posting.location } : {}),
      workplace: posting.workplace,
      employment_type: posting.employmentType,
      ...(posting.salary ? { salary: posting.salary } : {}),
      ...(posting.postedAt ? { posted_at: posting.postedAt } : {}),
      fetched_at: at,
      text_sha256: textSha256(body),
      ...(options.repostOf ? { repost_of: options.repostOf } : {}),
    };
    return this.#writeNew(id, {
      posting: frontmatter,
      body,
      status: {
        version: 1,
        state: "found",
        history: [{ at, from: null, to: "found", by: "system" }],
        notes: [],
        contacts: [],
        tags: [],
        listing: { live: true, since: at },
      },
      ...(options.html ? { html: options.html } : {}),
    });
  }

  /**
   * M5: the posting left its board (or came back). Recorded only when it changes. A job you have
   * not acted on yet (Found, Evaluated) is expired by the system; later states are only flagged.
   */
  setListing(
    id: string,
    live: boolean,
    reason: string,
  ): Promise<{ record: JobRecord; expired: boolean }> {
    let expired = false;
    return this.#updateStatus(id, (status) => {
      if ((status.listing?.live ?? true) === live && status.listing) return status;
      const at = localIsoDateTime();
      let next: StatusFile = { ...status, listing: { live, since: at } };
      if (!live && (status.state === "found" || status.state === "evaluated")) {
        next = applyTransition(next, { to: "expired", reason }, { at, by: "system" });
        expired = true;
      }
      return next;
    }).then((record) => ({ record, expired }));
  }

  /** Replaces the posting text (for postings imported without it, such as LinkedIn alerts). */
  setPostingText(id: string, text: string): Promise<JobRecord> {
    return this.#withLock(id, async () => {
      const path = join(jobDir(this.#app.root, id), JOB_FILES.posting);
      const current = await readTextFile(path);
      if (current === null) throw new HttpError(409, "posting-missing", "posting.md is missing.");
      const split = splitFrontmatter(current);
      const parsed = split.yaml
        ? parseYaml(split.yaml, PostingFrontmatter, { file: "posting.md" }).value
        : null;
      if (!parsed)
        throw new HttpError(409, "posting-invalid", "posting.md has errors. Fix the file first.");
      const body = normalizePostingText(text);
      await writeFileAtomic(
        path,
        joinFrontmatter(
          { ...parsed, text_sha256: textSha256(body), fetched_at: localIsoDateTime() },
          body,
        ),
      );
      return this.#reload(id);
    });
  }

  async create(input: CreateInput, snapshot?: Snapshot): Promise<JobRecord> {
    const now = new Date();
    const id = await this.#allocate(input.company, input.title, now);

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
    return this.#writeNew(id, {
      posting: frontmatter,
      body,
      status,
      ...(snapshot ? { html: snapshot.html } : {}),
    });
  }

  async transition(
    id: string,
    req: TransitionRequest,
    by: StatusEvent["by"] = "user",
  ): Promise<JobRecord> {
    return this.#updateStatus(id, async (status) => {
      const check = checkTransition(status, req, await guardContextFor(this.#app.root, id));
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

  /** Moves the job only if it is in `from`; used for automatic moves (by the system). */
  async moveIf(id: string, from: StatusFile["state"][], to: StatusFile["state"]): Promise<boolean> {
    try {
      let moved = false;
      await this.#updateStatus(id, async (status) => {
        if (!from.includes(status.state)) return status;
        const check = checkTransition(status, { to }, await guardContextFor(this.#app.root, id));
        if (!check.ok) return status;
        moved = true;
        return applyTransition(status, { to }, { at: localIsoDateTime(), by: "system" });
      });
      return moved;
    } catch {
      return false;
    }
  }

  setBase(id: string, base: string): Promise<JobRecord> {
    return this.#updateStatus(id, (status) => ({ ...status, base }));
  }

  /**
   * Approves the tailored CV: records the SHA-256 of the exact cv.pdf and moves ready -> approved.
   * Guard G2 is checked against the files on disk inside the job's lock.
   */
  approve(
    id: string,
    approval: { cvSha256: string; base: string; overrideReason?: string | undefined },
  ): Promise<JobRecord> {
    return this.#updateStatus(id, async (status) => {
      const ctx = await guardContextFor(this.#app.root, id);
      if (ctx.cvPdfSha256 !== approval.cvSha256) {
        throw new HttpError(
          409,
          "changed-on-disk",
          "cv.pdf changed while you were reviewing it. Look at it again before approving.",
        );
      }
      const check = checkTransition(status, { to: "approved" }, ctx);
      if (!check.ok) throw new HttpError(409, check.code, check.message);
      const at = localIsoDateTime();
      const next = applyTransition(status, { to: "approved" }, { at, by: "user" });
      return {
        ...next,
        base: approval.base,
        approval: {
          at,
          cv_sha256: approval.cvSha256,
          base: approval.base,
          ...(approval.overrideReason ? { override_reason: approval.overrideReason } : {}),
        },
      };
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

  /** The cover letter's own approval, locked to the SHA-256 of cover-letter.pdf. */
  approveCoverLetter(id: string, pdfSha256: string): Promise<JobRecord> {
    return this.#updateStatus(id, async (status) => {
      const state = await readDocState(this.#app.root, id, COVER_LETTER_FILES);
      if (state.pdfSha256 !== pdfSha256 || !state.verified) {
        throw new HttpError(
          409,
          "changed-on-disk",
          "cover-letter.pdf changed while you were reviewing it. Look at it again before approving.",
        );
      }
      return { ...status, cover_letter_approval: { at: localIsoDateTime(), sha256: pdfSha256 } };
    });
  }

  /**
   * Records that you submitted the application: approved -> applied. Guard G3 (the PDF is the one
   * you approved) is checked against the files inside the job's lock, and so is the cover letter.
   */
  recordApplication(
    id: string,
    application: { method: "manual" | "assisted"; coverLetterSha256?: string | undefined },
  ): Promise<JobRecord> {
    return this.#updateStatus(id, async (status) => {
      const check = checkTransition(
        status,
        { to: "applied" },
        await guardContextFor(this.#app.root, id),
      );
      if (!check.ok) throw new HttpError(409, check.code, check.message);
      const cover = application.coverLetterSha256;
      if (cover && status.cover_letter_approval?.sha256 !== cover) {
        throw new HttpError(
          409,
          "cover-letter-changed",
          "The cover letter is not the one you approved. Approve it again or apply without it.",
        );
      }
      const at = localIsoDateTime();
      const next = applyTransition(status, { to: "applied" }, { at, by: "user" });
      return {
        ...next,
        application: {
          at,
          method: application.method,
          ...(status.approval ? { cv_sha256: status.approval.cv_sha256 } : {}),
          ...(cover ? { cover_letter_sha256: cover } : {}),
        },
      };
    });
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
