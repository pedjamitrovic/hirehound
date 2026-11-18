import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { joinFrontmatter, splitFrontmatter } from "../../shared/frontmatter.ts";
import type { Answer } from "../../shared/schemas/answers.ts";
import type {
  ApplicationView,
  AssistState,
  FieldOutcome,
  FormField,
  TaskInfo,
} from "../../shared/schemas/api.ts";
import { ApplicationFile, type UsedAnswer } from "../../shared/schemas/application.ts";
import type { Contact } from "../../shared/schemas/contact.ts";
import { STATE_LABELS } from "../../shared/states.ts";
import { localIsoDate, localIsoDateTime } from "../../shared/time.ts";
import { runTask } from "../ai/run-task.ts";
import type { AiService } from "../ai/service.ts";
import { HttpError } from "../http/router.ts";
import type { JobService } from "../jobs/service.ts";
import type { ProfileService } from "../profile/service.ts";
import type { TaskContext, TaskRunner } from "../tasks.ts";
import { isNotFound, readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import type { WorkspaceIndex } from "../workspace/index.ts";
import { type JobRecord, sha256 } from "../workspace/job-files.ts";
import { JOB_FILES, jobDir } from "../workspace/layout.ts";
import { parseYaml } from "../workspace/yamlfile.ts";
import { type ApplyBrowser, BrowserError, type FillAction } from "./browser.ts";
import { isConsentQuestion, isSensitiveQuestion } from "./form.ts";
import { mapFormTask } from "./tasks.ts";

type Deps = {
  root: string;
  index: WorkspaceIndex;
  jobs: JobService;
  profile: ProfileService;
  ai: AiService;
  tasks: TaskRunner;
  browser: ApplyBrowser;
};

type Session = {
  fields: FieldOutcome[];
  filledAt: string | null;
  answers: Map<string, UsedAnswer>;
};

/** The approved document the form gets, with a file name a recruiter can read. */
type Doc = { sha256: string; data: Buffer; name: string };

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function safeName(text: string): string {
  return text
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * M4: applying. Manual mode is a checklist plus "I submitted". Assisted mode opens the application
 * in Hirehound's own visible browser, reads the form, lets Claude map it to your data and fills
 * it; questions it should not answer come back to you. Neither mode ever submits: you press Submit.
 */
export class ApplyService {
  readonly #d: Deps;
  #sessions = new Map<string, Session>();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #record(id: string): JobRecord {
    const record = this.#d.index.get(id);
    if (!record) throw new HttpError(404, "job-not-found", `No job with id ${id}`);
    return record;
  }

  #session(id: string): Session {
    let session = this.#sessions.get(id);
    if (!session) {
      session = { fields: [], filledAt: null, answers: new Map() };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #path(id: string, file: string): string {
    return join(jobDir(this.#d.root, id), file);
  }

  fileName(record: JobRecord, kind: "CV" | "Cover letter", contactName: string | null): string {
    return `${safeName(`${contactName ?? "My"} ${kind} - ${record.summary.company}`)}.pdf`;
  }

  /** The approved CV, only if cv.pdf is still exactly the approved file. */
  async #approvedCv(record: JobRecord, contact: Contact | null): Promise<Doc | null> {
    const approval = record.status?.approval;
    if (!approval) return null;
    try {
      const data = await readFile(this.#path(record.id, JOB_FILES.cvPdf));
      if (sha256(data) !== approval.cv_sha256) return null;
      return {
        sha256: approval.cv_sha256,
        data,
        name: this.fileName(record, "CV", contact?.name ?? null),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async #approvedCoverLetter(record: JobRecord, contact: Contact | null): Promise<Doc | null> {
    const approval = record.status?.cover_letter_approval;
    if (!approval) return null;
    try {
      const data = await readFile(this.#path(record.id, JOB_FILES.coverLetterPdf));
      if (sha256(data) !== approval.sha256) return null;
      return {
        sha256: approval.sha256,
        data,
        name: this.fileName(record, "Cover letter", contact?.name ?? null),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async #readRecord(id: string): Promise<ApplicationFile | null> {
    const text = await readTextFile(this.#path(id, JOB_FILES.application));
    if (text === null) return null;
    const split = splitFrontmatter(text);
    if (split.yaml === null) return null;
    return parseYaml(split.yaml, ApplicationFile, { file: `jobs/${id}/${JOB_FILES.application}` })
      .value;
  }

  async state(id: string): Promise<AssistState> {
    const session = this.#sessions.get(id);
    const info = await this.#d.browser.info(id);
    return {
      open: info !== null,
      url: info?.url ?? null,
      title: info?.title ?? null,
      captcha: info?.captcha ?? false,
      fields: session?.fields ?? [],
      filledAt: session?.filledAt ?? null,
      answers: [...(session?.answers.values() ?? [])],
    };
  }

  async view(id: string): Promise<ApplicationView> {
    const record = this.#record(id);
    const { profile } = this.#d;
    const contact = (await profile.contact()).value;
    const prefs = (await profile.preferences()).value;
    const answers = await profile.answers();
    const state = record.status?.state ?? "found";
    const cv = await this.#approvedCv(record, contact);
    const cover = await this.#approvedCoverLetter(record, contact);

    const blockers: string[] = [];
    if (state === "applied" || record.status?.application) {
      blockers.push(
        `Applied${record.status?.application ? ` on ${record.status.application.at.slice(0, 10)}` : ""}.`,
      );
    } else if (state !== "approved") {
      blockers.push(`The job is ${STATE_LABELS[state]}; applying starts once the CV is approved.`);
    } else if (!cv) {
      blockers.push("cv.pdf changed after it was approved. Review and approve it again.");
    }

    const rows: { label: string; value: string }[] = [];
    if (contact) {
      const [first, ...rest] = contact.name.split(/\s+/);
      rows.push({ label: "Full name", value: contact.name });
      if (rest.length) {
        rows.push({ label: "First name", value: first ?? "" });
        rows.push({ label: "Last name", value: rest.join(" ") });
      }
      rows.push({ label: "Email", value: contact.email });
      if (contact.phone) rows.push({ label: "Phone", value: contact.phone });
      if (contact.location) rows.push({ label: "Location", value: contact.location });
      for (const link of contact.links) rows.push({ label: link.label, value: link.url });
    }

    return {
      state,
      mode: prefs?.apply.mode ?? "manual",
      url: record.posting?.url ?? null,
      cv: {
        sha256: record.status?.approval?.cv_sha256 ?? null,
        approved: cv !== null,
        fileName: this.fileName(record, "CV", contact?.name ?? null),
      },
      coverLetter: cover ? { sha256: cover.sha256, approved: true, fileName: cover.name } : null,
      contact: rows,
      answers: answers.value?.answers ?? [],
      answersSha256: answers.sha256,
      record: await this.#readRecord(id),
      blockers,
      assist: await this.state(id),
    };
  }

  // ---------- Assisted ----------

  async open(id: string, url: string): Promise<AssistState> {
    const record = this.#record(id);
    if (record.status?.state !== "approved") {
      throw new HttpError(
        409,
        "not-approved",
        "Approve the CV first; assisted apply attaches the approved PDF.",
      );
    }
    try {
      await this.#d.browser.open(id, url);
    } catch (error) {
      if (error instanceof BrowserError) throw new HttpError(503, error.code, error.message);
      throw error;
    }
    return this.state(id);
  }

  async close(id: string): Promise<AssistState> {
    await this.#d.browser.closeJob(id);
    this.#sessions.delete(id);
    return this.state(id);
  }

  /** Reads the form on the current page, maps it with Claude and fills it. Never submits. */
  startFill(id: string): TaskInfo {
    const record = this.#record(id);
    if (!this.#d.browser.page(id)) {
      throw new HttpError(409, "not-open", "Open the application page in the browser first.");
    }
    return this.#d.tasks.start(
      "fill-form",
      `Filling the application for ${record.summary.company}`,
      (ctx) => this.#fill(id, ctx),
      { jobId: id },
    );
  }

  async #fill(id: string, ctx: TaskContext) {
    const { browser, profile } = this.#d;
    const record = this.#record(id);
    ctx.progress("Reading the form");
    let scanned: { fields: FormField[]; captcha: boolean };
    try {
      scanned = await browser.scan(id);
    } catch (error) {
      if (error instanceof BrowserError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
    const session = this.#session(id);
    if (scanned.fields.length === 0) {
      session.fields = [];
      session.filledAt = localIsoDateTime();
      return {
        filled: 0,
        asked: 0,
        failed: 0,
        message:
          "No form fields on this page. Open the application form (often behind an Apply button) and try again.",
      };
    }
    const contact = (await profile.contact()).value;
    const library = (await profile.answers()).value?.answers ?? [];
    const cv = await this.#approvedCv(record, contact);
    const cover = await this.#approvedCoverLetter(record, contact);
    const result = await runTask(
      this.#d.ai,
      mapFormTask,
      {
        job: {
          company: record.summary.company,
          title: record.summary.title,
          url: record.posting?.url ?? null,
        },
        contact,
        preferences: (await profile.preferences()).value,
        answers: library,
        documents: { cv: cv !== null, coverLetter: cover !== null },
        fields: scanned.fields,
        today: localIsoDate(),
      },
      { root: this.#d.root, jobId: id, signal: ctx.signal, onProgress: ctx.aiProgress },
    );
    ctx.addUsage(result.usage);
    ctx.progress("Filling the form");

    const decisions = new Map(result.output.fields.map((f) => [f.id, f]));
    const byAnswerId = new Map(library.map((a) => [a.id, a]));
    const outcomes: FieldOutcome[] = [];
    const actions: { action: FillAction; outcome: FieldOutcome; shown: string }[] = [];
    for (const field of scanned.fields) {
      const d = decisions.get(field.id);
      const libraryAnswer = d?.answer_id ? byAnswerId.get(d.answer_id) : undefined;
      const base: FieldOutcome = { ...field, status: "skipped" };
      const ask = (note: string | null, suggestion?: string | null) =>
        outcomes.push({
          ...base,
          status: "ask",
          ...(note ? { note } : {}),
          ...(suggestion ? { suggestion } : {}),
        });
      const same = (a: string, b: string) =>
        a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") ===
        b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

      if (!d) {
        if (field.required && !field.value) ask("Required, and Claude had no answer for it.");
        else outcomes.push({ ...base, status: field.value ? "kept" : "skipped" });
        continue;
      }
      // Code-level guard rails: whatever the model said, these are your decisions.
      if (isSensitiveQuestion(field.label) || libraryAnswer?.sensitive) {
        ask(
          "A sensitive question: Hirehound never answers these without you.",
          d.suggestion ?? libraryAnswer?.answer,
        );
        continue;
      }
      if (isConsentQuestion(field.label) && (field.type === "checkbox" || field.type === "radio")) {
        ask("Accepting terms or giving consent is your decision.");
        continue;
      }
      if (d.action === "ask") {
        // The model's question only adds something when it differs from the label.
        ask(d.question && !same(d.question, field.label) ? d.question : null, d.suggestion);
        continue;
      }
      if (d.action === "skip") {
        outcomes.push({ ...base, status: field.value ? "kept" : "skipped" });
        continue;
      }
      const source = d.source ?? "profile";
      const meta = { source, ...(libraryAnswer ? { answerId: libraryAnswer.id } : {}) } as const;
      if (d.action === "upload-cv" || d.action === "upload-cover-letter") {
        const doc = d.action === "upload-cv" ? cv : cover;
        if (!doc) {
          ask("The approved PDF is not available. Approve it again first.");
          continue;
        }
        const outcome: FieldOutcome = {
          ...base,
          status: "uploaded",
          filled: doc.name,
          source: "document",
        };
        actions.push({
          action: { id: field.id, kind: "upload", file: { name: doc.name, data: doc.data } },
          outcome,
          shown: doc.name,
        });
        continue;
      }
      const value = (d.value ?? "").trim();
      if (d.action === "check") {
        const checked = value.toLowerCase() === "true";
        const outcome: FieldOutcome = {
          ...base,
          status: "filled",
          filled: checked ? "Ticked" : "Not ticked",
          ...meta,
        };
        actions.push({
          action: { id: field.id, kind: "check", checked },
          outcome,
          shown: outcome.filled ?? "",
        });
        continue;
      }
      if (d.action === "choose") {
        const option =
          field.options.find((o) => o.label === value) ??
          field.options.find((o) => o.value === value);
        if (!option) {
          ask(`Claude chose "${value}", which is not one of the options.`);
          continue;
        }
        const target = field.type === "radio" ? (option.id ?? field.id) : field.id;
        const outcome: FieldOutcome = { ...base, status: "filled", filled: option.label, ...meta };
        actions.push({
          action: { id: target, kind: "choose", value: option.label },
          outcome,
          shown: option.label,
        });
        continue;
      }
      if (field.value && field.value === value) {
        outcomes.push({ ...base, status: "kept" });
        continue;
      }
      const outcome: FieldOutcome = { ...base, status: "filled", filled: value, ...meta };
      actions.push({ action: { id: field.id, kind: "fill", value }, outcome, shown: value });
    }

    const results = await browser.fill(
      id,
      actions.map((a) => a.action),
    );
    for (const [i, { outcome, shown }] of actions.entries()) {
      const r = results[i];
      if (r?.ok) {
        outcomes.push(outcome);
        session.answers.set(outcome.label || outcome.id, {
          question: outcome.label || outcome.id,
          answer: shown,
          source: outcome.source ?? "profile",
          ...(outcome.answerId ? { answer_id: outcome.answerId } : {}),
        });
      } else {
        outcomes.push({ ...outcome, status: "failed", note: r?.error ?? "Could not fill it." });
      }
    }
    const order = new Map(scanned.fields.map((f, i) => [f.id, i]));
    session.fields = outcomes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    session.filledAt = localIsoDateTime();
    const count = (status: FieldOutcome["status"]) =>
      outcomes.filter((o) => o.status === status).length;
    return {
      filled: count("filled") + count("uploaded"),
      asked: count("ask"),
      failed: count("failed"),
      captcha: scanned.captcha,
    };
  }

  /** Your answers to the questions Hirehound asked: filled in directly, optionally saved. */
  async answer(
    id: string,
    answers: { fieldId: string; value: string; save?: boolean | undefined }[],
  ): Promise<AssistState> {
    const session = this.#session(id);
    const actions: FillAction[] = [];
    const pending: { outcome: FieldOutcome; shown: string; save: boolean }[] = [];
    for (const a of answers) {
      const field = session.fields.find((f) => f.id === a.fieldId);
      if (!field) throw new HttpError(409, "stale", "That form changed. Fill the page again.");
      const value = a.value.trim();
      if (!value) continue;
      if (field.type === "radio" || field.type === "select") {
        const option = field.options.find((o) => o.label === value || o.value === value);
        if (!option)
          throw new HttpError(
            400,
            "invalid-option",
            `"${value}" is not an option for ${field.label}.`,
          );
        actions.push({
          id: field.type === "radio" ? (option.id ?? field.id) : field.id,
          kind: "choose",
          value: option.label,
        });
        pending.push({ outcome: field, shown: option.label, save: Boolean(a.save) });
      } else if (field.type === "checkbox") {
        const checked = /^(true|yes|1|on|ticked)$/i.test(value);
        actions.push({ id: field.id, kind: "check", checked });
        pending.push({ outcome: field, shown: checked ? "Ticked" : "Not ticked", save: false });
      } else if (field.type === "file") {
        throw new HttpError(400, "file-field", "Attach files in the browser window yourself.");
      } else {
        actions.push({ id: field.id, kind: "fill", value });
        pending.push({ outcome: field, shown: value, save: Boolean(a.save) });
      }
    }
    let results: Awaited<ReturnType<ApplyBrowser["fill"]>>;
    try {
      results = await this.#d.browser.fill(id, actions);
    } catch (error) {
      if (error instanceof BrowserError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
    const toSave: Parameters<ProfileService["saveAnswers"]>[0] = [];
    for (const [i, { outcome, shown, save }] of pending.entries()) {
      const ok = results[i]?.ok;
      const index = session.fields.findIndex((f) => f.id === outcome.id);
      const next: FieldOutcome = ok
        ? { ...outcome, status: "filled", filled: shown, source: "you" }
        : { ...outcome, status: "failed", note: results[i]?.error ?? "Could not fill it." };
      if (index >= 0) session.fields[index] = next;
      if (!ok) continue;
      session.answers.set(outcome.label || outcome.id, {
        question: outcome.label || outcome.id,
        answer: shown,
        source: "you",
      });
      if (save && outcome.label) {
        toSave.push({
          question: outcome.label,
          answer: shown,
          kind: answerKind(outcome.type),
          sensitive: isSensitiveQuestion(outcome.label),
        });
      }
    }
    if (toSave.length) await this.#d.profile.saveAnswers(toSave);
    return this.state(id);
  }

  // ---------- "I submitted" ----------

  async submitted(
    id: string,
    body: {
      method: "manual" | "assisted";
      url?: string | undefined;
      confirmationText?: string | undefined;
      coverLetter?: boolean | undefined;
    },
  ): Promise<JobRecord> {
    const record = this.#record(id);
    if (record.status?.state !== "approved") {
      throw new HttpError(409, "not-approved", "Only an approved CV can be recorded as applied.");
    }
    const contact = (await this.#d.profile.contact()).value;
    const cv = await this.#approvedCv(record, contact);
    if (!cv) {
      throw new HttpError(
        409,
        "guard",
        "cv.pdf changed after it was approved. Review and approve it again.",
      );
    }
    const cover = body.coverLetter ? await this.#approvedCoverLetter(record, contact) : null;
    if (body.coverLetter && !cover) {
      throw new HttpError(
        409,
        "cover-letter-changed",
        "There is no approved cover letter matching cover-letter.pdf.",
      );
    }
    const at = localIsoDateTime();
    let snapshot: Awaited<ReturnType<ApplyBrowser["snapshot"]>> | null = null;
    if (body.method === "assisted" && this.#d.browser.page(id)) {
      snapshot = await this.#d.browser.snapshot(id).catch(() => null);
    }
    const typed = body.confirmationText?.trim();
    const file: ApplicationFile = {
      version: 1,
      applied_at: at,
      method: body.method,
      ...(body.url?.trim() || snapshot?.url || record.posting?.url
        ? { url: body.url?.trim() || snapshot?.url || record.posting?.url }
        : {}),
      cv: { file: JOB_FILES.cvPdf, sha256: cv.sha256 },
      ...(cover ? { cover_letter: { file: JOB_FILES.coverLetterPdf, sha256: cover.sha256 } } : {}),
      answers: [...(this.#sessions.get(id)?.answers.values() ?? [])],
      ...(snapshot || typed
        ? {
            confirmation: {
              captured_at: at,
              ...(snapshot?.url ? { url: snapshot.url } : {}),
              ...(snapshot?.title ? { title: snapshot.title } : {}),
              ...(typed || snapshot?.text ? { text: typed || snapshot?.text } : {}),
              ...(snapshot ? { screenshot: JOB_FILES.confirmation } : {}),
            },
          }
        : {}),
    };
    const written: string[] = [];
    try {
      if (snapshot) {
        await writeFileAtomic(this.#path(id, JOB_FILES.confirmation), snapshot.png);
        written.push(JOB_FILES.confirmation);
      }
      await writeFileAtomic(
        this.#path(id, JOB_FILES.application),
        joinFrontmatter(file, applicationMarkdown(file, record)),
      );
      written.push(JOB_FILES.application);
      const next = await this.#d.jobs.recordApplication(id, {
        method: body.method,
        coverLetterSha256: cover?.sha256,
      });
      this.#sessions.delete(id);
      return next;
    } catch (error) {
      // Nothing half-recorded: the files only stay when the state moved to applied.
      for (const name of written) await rm(this.#path(id, name), { force: true });
      throw error;
    }
  }
}

function answerKind(type: FormField["type"]): Answer["kind"] {
  if (type === "number") return "number";
  if (type === "url") return "url";
  if (type === "date") return "date";
  if (type === "select" || type === "radio") return "choice";
  return "text";
}

const SOURCE_LABEL = {
  profile: "contact details",
  library: "saved answer",
  job: "the posting",
  you: "you",
  document: "file",
};

export function applicationMarkdown(file: ApplicationFile, record: JobRecord): string {
  const lines = [
    `# Application: ${record.summary.title} at ${record.summary.company}`,
    "",
    `Applied ${file.applied_at} (${file.method === "assisted" ? "assisted, submitted by you" : "manual"})${file.url ? ` at ${file.url}` : ""}.`,
    "",
    `- CV: ${file.cv.file} (sha256 ${file.cv.sha256})`,
  ];
  if (file.cover_letter)
    lines.push(`- Cover letter: ${file.cover_letter.file} (sha256 ${file.cover_letter.sha256})`);
  if (file.answers.length) {
    lines.push("", `## Answers (${plural(file.answers.length, "field")})`, "");
    for (const a of file.answers)
      lines.push(`- **${a.question}**: ${a.answer} _(${SOURCE_LABEL[a.source]})_`);
  }
  if (file.confirmation) {
    lines.push("", "## Confirmation", "");
    if (file.confirmation.title || file.confirmation.url) {
      lines.push(
        `${file.confirmation.title ?? ""}${file.confirmation.url ? ` (${file.confirmation.url})` : ""}`,
        "",
      );
    }
    if (file.confirmation.text)
      lines.push(
        file.confirmation.text
          .trim()
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
        "",
      );
    if (file.confirmation.screenshot)
      lines.push(`![Confirmation](${file.confirmation.screenshot})`);
  }
  return lines.join("\n");
}
