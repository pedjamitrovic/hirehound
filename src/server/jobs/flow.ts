import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { entryLabel, type IndexedEntry, indexBank } from "../../shared/bank.ts";
import { type CheckIssue, checkTailoredCv, emptyCheckCounts } from "../../shared/cv/checks.ts";
import { type Claim, cvClaims, inlinePlain } from "../../shared/cv/claims.ts";
import { type ClaimDiff, diffClaims } from "../../shared/cv/diff.ts";
import { parseCv } from "../../shared/cv/parse.ts";
import { cvPlainText } from "../../shared/cv/render.ts";
import type { Block, CvDoc } from "../../shared/cv/types.ts";
import { joinFrontmatter, splitFrontmatter } from "../../shared/frontmatter.ts";
import type {
  ClaimView,
  CoverLetterView,
  CvIssue,
  CvRow,
  CvView,
  EvaluationView,
  EvidenceInfo,
  TaskInfo,
} from "../../shared/schemas/api.ts";
import type { BankFile } from "../../shared/schemas/bank.ts";
import {
  BaseCvFrontmatter,
  type CoverLetterAngle,
  CoverLetterFrontmatter,
  type CvTheme,
  TailoredCvFrontmatter,
} from "../../shared/schemas/cv.ts";
import type { EvaluationFrontmatter } from "../../shared/schemas/evaluation.ts";
import type {
  RenderInfo,
  VerificationFile,
  VerifiedClaim,
} from "../../shared/schemas/verification.ts";
import { computeScore } from "../../shared/score.ts";
import { isPreApply, STATE_LABELS } from "../../shared/states.ts";
import { localIsoDate, localIsoDateTime } from "../../shared/time.ts";
import { formatPath } from "../../shared/validate.ts";
import { runTask } from "../ai/run-task.ts";
import type { AiService } from "../ai/service.ts";
import { HttpError } from "../http/router.ts";
import { cvDocumentHtml, letterDocumentHtml, themeCss } from "../pdf/document.ts";
import type { PdfRenderer } from "../pdf/render.ts";
import { extractPdfText, pdfFontTypes, textCoverage } from "../pdf/text.ts";
import type { ProfileService } from "../profile/service.ts";
import type { TaskContext, TaskRunner } from "../tasks.ts";
import { isNotFound, readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import type { WorkspaceIndex } from "../workspace/index.ts";
import {
  COVER_LETTER_FILES,
  CV_FILES,
  type CvState,
  type DocFiles,
  type JobRecord,
  readCvState,
  readDocState,
  sha256,
} from "../workspace/job-files.ts";
import { JOB_FILES, jobDir } from "../workspace/layout.ts";
import { changesMarkdown, evaluationMarkdown } from "./documents.ts";
import type { JobService } from "./service.ts";
import {
  type BaseChoice,
  coverLetterTask,
  entryEvidenceText,
  evaluateTask,
  postingText,
  tailorTask,
  toEvaluation,
  verifyTask,
} from "./tasks.ts";

type Deps = {
  root: string;
  index: WorkspaceIndex;
  jobs: JobService;
  profile: ProfileService;
  ai: AiService;
  tasks: TaskRunner;
  pdf: PdfRenderer;
};

type BankState = { bank: BankFile | null; sha256: string | null; index: Map<string, IndexedEntry> };

/** Minimum share of the CV's words that must come back out of the PDF before we warn. */
const ATS_MIN_COVERAGE = 0.98;

/** The two documents the flow writes, checks and renders. */
type DocKind = "cv" | "cover-letter";
const DOC_FILES: Record<DocKind, DocFiles> = { cv: CV_FILES, "cover-letter": COVER_LETTER_FILES };

const LETTER_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

type ClaimViews = {
  views: ClaimView[];
  counts: { supported: number; weakened: number; unsupported: number };
  unverified: number;
  /** Ids whose bank content changed after the claim that cites them was verified. */
  bankChanged: Set<string>;
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The M3 flow for one job: evaluate the posting, tailor a CV from a base, check it
 * (deterministic checks, faithfulness verifier, PDF render and ATS round trip) and approve it.
 * AI work runs as background tasks, one per job at a time. Files stay the source of truth: every
 * step writes its result into the job folder and the index picks it up.
 */
export class JobFlow {
  readonly #d: Deps;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #record(id: string): JobRecord {
    const record = this.#d.index.get(id);
    if (!record) throw new HttpError(404, "job-not-found", `No job with id ${id}`);
    return record;
  }

  #path(id: string, file: string): string {
    return join(jobDir(this.#d.root, id), file);
  }

  async #bank(): Promise<BankState> {
    const file = await this.#d.profile.bank();
    return {
      bank: file.value,
      sha256: file.sha256,
      index: file.value ? indexBank(file.value) : new Map(),
    };
  }

  #requireConfirmed(state: BankState): BankFile {
    const confirmed = [...state.index.values()].some((e) => e.entry.confirmed);
    if (!state.bank || !confirmed) {
      throw new HttpError(
        409,
        "nothing-confirmed",
        "Confirm some experience bank entries first (Profile, Experience bank); only confirmed facts are used.",
      );
    }
    return state.bank;
  }

  #evidence(ids: Iterable<string>, index: Map<string, IndexedEntry>): Record<string, EvidenceInfo> {
    const out: Record<string, EvidenceInfo> = {};
    for (const id of ids) {
      if (out[id]) continue;
      const entry = index.get(id);
      out[id] = entry
        ? {
            id,
            kind: entry.kind,
            label: entryLabel(entry),
            confirmed: entry.entry.confirmed,
            detail: entryEvidenceText(entry, index),
          }
        : { id, kind: null, label: "Not in the experience bank", confirmed: false, detail: "" };
    }
    return out;
  }

  async #reload(id: string): Promise<void> {
    await this.#d.index.reloadJob(id);
  }

  // ---------- Evaluate ----------

  startEvaluate(id: string): TaskInfo {
    const record = this.#record(id);
    if (!record.posting) {
      throw new HttpError(
        409,
        "posting-invalid",
        "posting.md is missing or has errors. Fix it first.",
      );
    }
    if (!record.postingBody.trim()) {
      throw new HttpError(
        409,
        "no-posting-text",
        "The posting has no text yet. Paste it in the Posting tab, then evaluate.",
      );
    }
    if (record.status && !isPreApply(record.status.state)) {
      throw new HttpError(409, "past-evaluation", "This job has been applied to already.");
    }
    const { company } = record.summary;
    return this.#d.tasks.start(
      "evaluate",
      `Evaluating ${company}`,
      async (ctx) => {
        const { profile } = this.#d;
        const bankState = await this.#bank();
        const bank = this.#requireConfirmed(bankState);
        const bases = await this.#baseChoices();
        if (bases.length === 0) {
          throw new HttpError(
            409,
            "no-bases",
            "Create a base CV first (Profile, Base CVs): the evaluation picks the one to tailor from.",
          );
        }
        const postingText = await readTextFile(this.#path(id, JOB_FILES.posting));
        const current = this.#record(id);
        if (!postingText || !current.posting) {
          throw new HttpError(409, "posting-invalid", "posting.md is missing or has errors.");
        }
        ctx.progress("Reading the posting");
        const result = await runTask(
          this.#d.ai,
          evaluateTask,
          {
            posting: current.posting,
            body: current.postingBody,
            bank,
            bases,
            preferences: (await profile.preferences()).value,
            today: localIsoDate(),
          },
          { root: this.#d.root, jobId: id, signal: ctx.signal, onProgress: ctx.aiProgress },
        );
        ctx.addUsage(result.usage);
        const evaluation = toEvaluation(result.output);
        const score = computeScore(evaluation.fit.requirements);
        const front: EvaluationFrontmatter = {
          version: 1,
          ...evaluation,
          score: score.score,
          band: score.band,
          engine: { id: result.engine, model: result.model },
          created_at: localIsoDateTime(),
          posting_sha256: sha256(postingText),
          bank_sha256: bankState.sha256 ?? sha256(""),
        };
        await writeFileAtomic(
          this.#path(id, JOB_FILES.evaluation),
          joinFrontmatter(front, evaluationMarkdown(front, score, current.summary)),
        );
        await this.#d.jobs.moveIf(id, ["found"], "evaluated");
        if (!this.#record(id).status?.base) await this.#d.jobs.setBase(id, evaluation.level.base);
        await this.#reload(id);
        return { score: score.score, band: score.band, verdict: evaluation.recommendation.verdict };
      },
      { jobId: id },
    );
  }

  async #baseChoices(): Promise<BaseChoice[]> {
    const out: BaseChoice[] = [];
    for (const summary of await this.#d.profile.listBases()) {
      const detail = await this.#d.profile.readBase(summary.id);
      const front = BaseCvFrontmatter.safeParse({
        id: summary.id,
        ...parseCv(detail.text).doc.frontmatter,
      });
      out.push({
        id: summary.id,
        label: summary.label,
        track: summary.track,
        headline: summary.headline,
        targetTitles: front.success ? front.data.target_titles : [],
        emphasis: front.success ? front.data.emphasis : [],
      });
    }
    return out;
  }

  async evaluationView(id: string): Promise<EvaluationView> {
    const record = this.#record(id);
    const evaluation = record.evaluation;
    const { sha256: bankSha, index } = await this.#bank();
    const postingText = await readTextFile(this.#path(id, JOB_FILES.posting));
    const prefs = (await this.#d.profile.preferences()).value;
    const ids = evaluation?.fit.requirements.flatMap((r) => r.evidence) ?? [];
    return {
      evaluation,
      score: evaluation ? computeScore(evaluation.fit.requirements) : null,
      stale: {
        posting: Boolean(
          evaluation && postingText !== null && sha256(postingText) !== evaluation.posting_sha256,
        ),
        bank: Boolean(evaluation && bankSha !== null && bankSha !== evaluation.bank_sha256),
      },
      threshold: prefs?.scoring.threshold ?? 70,
      evidence: this.#evidence(ids, index),
      bases: (await this.#d.profile.listBases()).map((b) => ({ id: b.id, label: b.label })),
    };
  }

  // ---------- Tailor ----------

  startTailor(
    id: string,
    body: { base?: string | undefined; feedback?: string | undefined },
  ): TaskInfo {
    const record = this.#record(id);
    const state = record.status?.state ?? "found";
    if (state === "approved") {
      throw new HttpError(
        409,
        "approved",
        "This CV is approved. Revoke the approval (move the job back to Ready) to change it.",
      );
    }
    if (state === "found") {
      throw new HttpError(
        409,
        "not-evaluated",
        "Evaluate the job first: tailoring works from its requirements.",
      );
    }
    if (!["evaluated", "tailoring", "ready"].includes(state)) {
      throw new HttpError(
        409,
        "past-tailoring",
        `The job is ${STATE_LABELS[state]}; its CV can no longer change.`,
      );
    }
    if (body.feedback && !record.files.includes(JOB_FILES.cv)) {
      throw new HttpError(409, "no-cv", "There is no tailored CV to change yet.");
    }
    const baseId = body.base ?? record.status?.base ?? record.evaluation?.level.base;
    if (!baseId) throw new HttpError(409, "no-base", "Choose a base CV to tailor from.");
    const { company } = record.summary;
    return this.#d.tasks.start(
      "tailor",
      body.feedback ? `Revising the CV for ${company}` : `Tailoring the CV for ${company}`,
      async (ctx) => {
        const { profile } = this.#d;
        const base = await profile.readBase(baseId);
        const baseFront = BaseCvFrontmatter.safeParse({
          id: baseId,
          ...parseCv(base.text).doc.frontmatter,
        });
        const bankState = await this.#bank();
        const bank = this.#requireConfirmed(bankState);
        const prefs = (await profile.preferences()).value;
        const current = this.#record(id);
        const currentCv = body.feedback ? await readTextFile(this.#path(id, JOB_FILES.cv)) : null;

        await this.#d.jobs.moveIf(id, ["evaluated", "ready"], "tailoring");
        ctx.progress("Writing the tailored CV");
        const result = await runTask(
          this.#d.ai,
          tailorTask,
          {
            posting: current.posting,
            postingBody: current.postingBody,
            evaluation: current.evaluation,
            base: {
              id: baseId,
              label: base.summary.label,
              headline: base.summary.headline,
              body: splitFrontmatter(base.text).body,
            },
            bank,
            maxPages: prefs?.cv.max_pages ?? 2,
            feedback:
              body.feedback && currentCv
                ? { text: body.feedback, current: splitFrontmatter(currentCv).body }
                : undefined,
          },
          { root: this.#d.root, jobId: id, signal: ctx.signal, onProgress: ctx.aiProgress },
        );
        ctx.addUsage(result.usage);
        const out = result.output;
        const generatedAt = localIsoDateTime();
        const front: TailoredCvFrontmatter = {
          job: id,
          base: baseId,
          base_sha256: base.sha256,
          headline: out.headline,
          generated_at: generatedAt,
          engine: { id: result.engine, model: result.model },
          theme: baseFront.success ? baseFront.data.theme : "classic",
          ...(out.notes.trim() ? { notes: out.notes.trim() } : {}),
        };
        const cvText = joinFrontmatter(front, out.body);
        const diff = diffClaims(cvClaims(parseCv(base.text).doc), cvClaims(parseCv(cvText).doc));
        await writeFileAtomic(this.#path(id, JOB_FILES.cvBase), base.text);
        await writeFileAtomic(this.#path(id, JOB_FILES.cv), cvText);
        await writeFileAtomic(
          this.#path(id, JOB_FILES.changes),
          changesMarkdown({
            base: { id: baseId, sha256: base.sha256 },
            generatedAt,
            diff,
            changes: out.changes,
            notes: out.notes,
            feedback: body.feedback,
          }),
        );
        if (current.status?.base !== baseId) await this.#d.jobs.setBase(id, baseId);
        const file = await this.#check(id, ctx);
        return checkSummary(file);
      },
      { jobId: id },
    );
  }

  // ---------- Check: deterministic checks, verifier, PDF ----------

  startCheck(id: string): TaskInfo {
    const record = this.#record(id);
    if (!record.files.includes(JOB_FILES.cv)) {
      throw new HttpError(409, "no-cv", "There is no tailored CV to check yet.");
    }
    return this.#d.tasks.start(
      "check-cv",
      `Checking the CV for ${record.summary.company}`,
      async (ctx) => checkSummary(await this.#check(id, ctx)),
      { jobId: id },
    );
  }

  #claimKey(claim: Claim, index: Map<string, IndexedEntry>): string {
    const evidence = claim.ev.map((evId) => {
      const entry = index.get(evId);
      return entry ? entryEvidenceText(entry, index) : null;
    });
    return sha256(JSON.stringify([claim.text, claim.ev, evidence]));
  }

  #formatIssues(doc: CvDoc, parseIssues: CvIssue[], kind: DocKind = "cv"): CheckIssue[] {
    const issues: CheckIssue[] = parseIssues.map((i) => ({
      check: "format",
      n: -1,
      line: i.line,
      severity: i.severity,
      message: i.message,
    }));
    if (kind === "cover-letter") {
      for (const block of doc.blocks) {
        if (block.t === "section" || block.t === "entry" || block.t === "list") {
          issues.push({
            check: "format",
            n: -1,
            line: block.t === "list" ? (block.items[0]?.line ?? 1) : block.line,
            severity: "error",
            message: "A cover letter is plain paragraphs, without headings or bullets",
          });
        }
      }
    }
    const front = (kind === "cv" ? TailoredCvFrontmatter : CoverLetterFrontmatter).safeParse(
      doc.frontmatter,
    );
    if (!front.success) {
      for (const issue of front.error.issues) {
        issues.push({
          check: "format",
          n: -1,
          line: 1,
          severity: "error",
          message: `frontmatter ${formatPath(issue.path)}: ${issue.message}`,
        });
      }
    }
    return issues;
  }

  async #check(id: string, ctx: TaskContext, kind: DocKind = "cv"): Promise<VerificationFile> {
    const files = DOC_FILES[kind];
    const noun = kind === "cv" ? "CV" : "cover letter";
    const cvText = await readTextFile(this.#path(id, files.source));
    if (cvText === null) throw new HttpError(409, "no-document", `There is no ${noun} to check.`);
    const cvSha = sha256(cvText);
    const { doc, issues: parseIssues } = parseCv(cvText);
    const bankState = await this.#bank();
    const { index } = bankState;
    // A cover letter may state facts about the company and role that the posting gives.
    const record = this.#record(id);
    const context =
      kind === "cover-letter" ? postingText(record.posting, record.postingBody) : undefined;
    const checks: CheckIssue[] = [
      ...this.#formatIssues(doc, parseIssues, kind),
      ...checkTailoredCv(doc, bankState.bank, { context }).issues,
    ];

    // Faithfulness verifier: only claims whose text or evidence changed are sent again.
    const previous = (await readDocState(this.#d.root, id, files)).verification;
    const byKey = new Map(previous?.claims.map((c) => [c.key, c]) ?? []);
    const keyed = cvClaims(doc).map((claim) => ({ claim, key: this.#claimKey(claim, index) }));
    const todo = keyed.filter(
      ({ claim, key }) =>
        !byKey.has(key) && claim.ev.length > 0 && claim.ev.every((evId) => index.has(evId)),
    );
    let engine: VerificationFile["engine"] = null;
    const fresh = new Map<
      number,
      { verdict: VerifiedClaim["verdict"]; reason: string; suggestion: string | null }
    >();
    if (todo.length) {
      ctx.progress(`Verifying ${plural(todo.length, "claim")} against the experience bank`);
      const evidence = new Map<string, string>();
      for (const { claim } of todo) {
        for (const evId of claim.ev) {
          const entry = index.get(evId);
          if (entry && !evidence.has(evId)) evidence.set(evId, entryEvidenceText(entry, index));
        }
      }
      const result = await runTask(
        this.#d.ai,
        verifyTask,
        { claims: todo.map((t) => t.claim), evidence, posting: context },
        { root: this.#d.root, jobId: id, signal: ctx.signal, onProgress: ctx.aiProgress },
      );
      ctx.addUsage(result.usage);
      engine = { id: result.engine, model: result.model };
      for (const c of result.output.claims) fresh.set(c.n, c);
    }
    const now = localIsoDateTime();
    const claims: VerifiedClaim[] = keyed.map(({ claim, key }) => {
      const where = { n: claim.n, line: claim.line, text: claim.text, ev: claim.ev, key };
      const reused = byKey.get(key);
      if (reused) return { ...reused, ...where };
      const v = fresh.get(claim.n);
      if (v) {
        return {
          ...where,
          verdict: v.verdict,
          reason: v.reason,
          ...(v.verdict !== "supported" && v.suggestion?.trim()
            ? { suggestion: v.suggestion.trim() }
            : {}),
          verified_at: now,
        };
      }
      return {
        ...where,
        verdict: "unsupported" as const,
        reason: claim.ev.length
          ? "It cites entries that are not in the experience bank."
          : "It cites no experience-bank entry.",
        verified_at: now,
      };
    });

    // Render the PDF and read it back the way an ATS would.
    ctx.progress("Rendering the PDF");
    let render: RenderInfo | null = null;
    try {
      render = await this.#render(id, doc, kind);
      if (render.pages > render.max_pages) {
        checks.push({
          check: "format",
          n: -1,
          line: 1,
          severity: "warning",
          message:
            kind === "cv"
              ? `The PDF has ${render.pages} pages; your limit is ${render.max_pages} (Profile, Preferences).`
              : `The cover letter runs to ${render.pages} pages; keep it to one.`,
        });
      }
      if (render.ats.coverage < ATS_MIN_COVERAGE || render.ats.garbled > 0) {
        checks.push({
          check: "format",
          n: -1,
          line: 1,
          severity: "warning",
          message: `Only ${Math.floor(render.ats.coverage * 100)}% of the ${noun}'s words come back out of the PDF${render.ats.garbled ? `, and ${plural(render.ats.garbled, "character")} come out garbled` : ""}. An ATS reads the same text.${render.ats.missing.length ? ` Missing: ${render.ats.missing.join(", ")}.` : ""}`,
        });
      }
      if (render.ats.type3_fonts > 0) {
        checks.push({
          check: "format",
          n: -1,
          line: 1,
          severity: "warning",
          message: `The PDF embeds ${plural(render.ats.type3_fonts, "font")} as Type3 glyphs, which some ATS read poorly. A theme override in templates/ may use a variable font; static fonts avoid this.`,
        });
      }
    } catch (error) {
      checks.push({
        check: "format",
        n: -1,
        line: 1,
        severity: "warning",
        message: `No PDF: ${(error as Error).message}`,
      });
    }

    const file: VerificationFile = {
      version: 1,
      cv_sha256: cvSha,
      bank_sha256: bankState.sha256,
      checked_at: now,
      engine,
      checks,
      claims,
      render,
    };
    await this.#d.jobs.locked(id, async () => {
      if ((await readTextFile(this.#path(id, files.source))) !== cvText) {
        throw new HttpError(
          409,
          "changed-on-disk",
          `${files.source} changed while it was being checked. Check it again.`,
        );
      }
      await writeFileAtomic(
        this.#path(id, files.verification),
        `${JSON.stringify(file, null, 2)}\n`,
      );
    });
    if (kind === "cv") {
      // Ready means verified: keep the state in line with the guard.
      const verified = (await readCvState(this.#d.root, id)).verified;
      if (verified) await this.#d.jobs.moveIf(id, ["tailoring"], "ready");
      else await this.#d.jobs.moveIf(id, ["ready"], "tailoring");
    }
    await this.#reload(id);
    return file;
  }

  async #render(id: string, doc: CvDoc, kind: DocKind = "cv"): Promise<RenderInfo> {
    const { profile } = this.#d;
    const prefs = (await profile.preferences()).value;
    const contact = (await profile.contact()).value;
    const paper = prefs?.cv.paper ?? "a4";
    let html: string;
    let expected: string;
    let theme: CvTheme = "classic";
    if (kind === "cv") {
      const front = TailoredCvFrontmatter.safeParse(doc.frontmatter);
      theme = front.success ? front.data.theme : "classic";
      const headline = front.success ? front.data.headline : undefined;
      html = await cvDocumentHtml({
        doc,
        contact,
        headline,
        css: await themeCss(this.#d.root, theme),
        paper,
      });
      expected = [contact?.name, headline, cvPlainText(doc)].filter(Boolean).join("\n");
    } else {
      const front = CoverLetterFrontmatter.safeParse(doc.frontmatter);
      theme = front.success ? front.data.theme : "classic";
      const greeting = front.success ? front.data.greeting : "Dear hiring team,";
      const closing = front.success ? front.data.closing : "Kind regards,";
      html = await letterDocumentHtml({
        doc,
        contact,
        css: await themeCss(this.#d.root, theme),
        paper,
        greeting,
        closing,
        company: this.#record(id).summary.company,
        date: LETTER_DATE.format(new Date()),
      });
      expected = [contact?.name, greeting, cvPlainText(doc), closing].filter(Boolean).join("\n");
    }
    const { pdf, pages } = await this.#d.pdf.render(html, paper);
    await writeFileAtomic(this.#path(id, DOC_FILES[kind].pdf), pdf);
    const ats = textCoverage(expected, extractPdfText(pdf));
    return {
      pdf_sha256: sha256(pdf),
      pages,
      max_pages: kind === "cv" ? (prefs?.cv.max_pages ?? 2) : 1,
      rendered_at: localIsoDateTime(),
      theme,
      ats: {
        coverage: Math.round(ats.coverage * 1000) / 1000,
        missing: ats.missing,
        garbled: ats.garbled,
        type3_fonts: pdfFontTypes(pdf).Type3 ?? 0,
      },
    };
  }

  // ---------- Edit ----------

  async saveCv(id: string, text: string, expectedSha256: string | null): Promise<TaskInfo> {
    const record = this.#record(id);
    if (record.status?.state === "approved") {
      throw new HttpError(
        409,
        "approved",
        "This CV is approved. Revoke the approval (move the job back to Ready) to edit it.",
      );
    }
    if (this.#d.tasks.runningForJob(id)) {
      throw new HttpError(
        409,
        "job-busy",
        "Something is already running for this job. Wait for it to finish.",
      );
    }
    await this.#d.jobs.locked(id, async () => {
      const current = await readTextFile(this.#path(id, JOB_FILES.cv));
      if (current === null) throw new HttpError(404, "no-cv", "There is no tailored CV yet.");
      if (sha256(current) !== expectedSha256) {
        throw new HttpError(
          409,
          "changed-on-disk",
          "cv.md changed since you opened it (in another tab or an editor). Reload to see the latest version.",
        );
      }
      await writeFileAtomic(this.#path(id, JOB_FILES.cv), text.replace(/\r\n?/g, "\n"));
    });
    await this.#reload(id);
    return this.startCheck(id);
  }

  // ---------- Review ----------

  /** Verdicts and check issues per claim, reusing verdicts whose text and evidence are unchanged. */
  #claimViews(
    claims: Claim[],
    state: CvState,
    index: Map<string, IndexedEntry>,
    issues: CheckIssue[],
    diff: (claim: Claim) => Pick<ClaimView, "diff" | "baseText">,
  ): ClaimViews {
    const verification = state.verification;
    const stored = new Map(verification?.claims.map((c) => [c.key, c]) ?? []);
    const bankChanged = new Set<string>();
    let unverified = 0;
    const counts = { supported: 0, weakened: 0, unsupported: 0 };
    const views = claims.map((claim): ClaimView => {
      const verdict = stored.get(this.#claimKey(claim, index));
      if (verdict) counts[verdict.verdict] += 1;
      else {
        unverified += 1;
        const before = state.current
          ? verification?.claims.find((c) => c.n === claim.n)
          : undefined;
        if (before) for (const evId of claim.ev) bankChanged.add(evId);
      }
      return {
        n: claim.n,
        kind: claim.kind,
        inline: [],
        text: claim.text,
        ev: claim.ev,
        line: claim.line,
        ...diff(claim),
        verdict: verdict?.verdict ?? null,
        ...(verdict?.reason ? { reason: verdict.reason } : {}),
        ...(verdict?.suggestion ? { suggestion: verdict.suggestion } : {}),
        issues: issues.filter((i) => i.n === claim.n),
      };
    });
    return { views, counts, unverified, bankChanged };
  }

  async cvView(id: string): Promise<CvView> {
    const record = this.#record(id);
    const text = await readTextFile(this.#path(id, JOB_FILES.cv));
    if (text === null) throw new HttpError(404, "no-cv", "There is no tailored CV yet.");
    const { doc, issues: parseIssues } = parseCv(text);
    const front = TailoredCvFrontmatter.safeParse(doc.frontmatter);
    const raw = doc.frontmatter as Record<string, unknown>;
    const cvState = await readCvState(this.#d.root, id);
    const verification = cvState.verification;
    const bankState = await this.#bank();
    const { index } = bankState;
    const formatIssues = this.#formatIssues(doc, parseIssues);
    const live = checkTailoredCv(doc, bankState.bank);
    const claims = cvClaims(doc);

    // Diff against the base copy made at tailoring time.
    const baseText = await readTextFile(this.#path(id, JOB_FILES.cvBase));
    const diff = baseText ? diffClaims(cvClaims(parseCv(baseText).doc), claims) : [];
    const diffByN = new Map<number, ClaimDiff>();
    const removedBefore = new Map<number, ClaimDiff[]>();
    let pending: ClaimDiff[] = [];
    for (const d of diff) {
      if (d.op === "removed") pending.push(d);
      else {
        diffByN.set(d.cv.n, d);
        if (pending.length) removedBefore.set(d.cv.n, pending);
        pending = [];
      }
    }

    const { views, counts, unverified, bankChanged } = this.#claimViews(
      claims,
      cvState,
      index,
      live.issues,
      (claim) => {
        const d = diffByN.get(claim.n);
        return {
          diff: !baseText
            ? "same"
            : d?.op === "changed"
              ? "changed"
              : d?.op === "same"
                ? "same"
                : "added",
          ...(d?.op === "changed" ? { baseText: d.base.text } : {}),
        };
      },
    );
    const rows = buildRows(doc.blocks, views, removedBefore, pending);

    const evaluation = record.evaluation;
    const score = evaluation ? computeScore(evaluation.fit.requirements).score : null;
    const prefs = (await this.#d.profile.preferences()).value;
    const threshold = prefs?.scoring.threshold ?? 70;
    const state = record.status?.state ?? "found";
    const allChecks = [...formatIssues, ...live.issues];
    const errors = emptyCheckCounts();
    for (const i of allChecks) if (i.severity === "error") errors[i.check] += 1;
    const failed = Object.entries(errors)
      .filter(([, n]) => n > 0)
      .map(([check]) => check);

    const blockers: string[] = [];
    if (state === "approved") blockers.push("Already approved.");
    else if (state !== "ready" && state !== "tailoring") {
      blockers.push(`The job is ${STATE_LABELS[state]}; approval happens in Ready.`);
    }
    if (failed.length)
      blockers.push(`Checks failed: ${failed.join(", ")}. Fix the lines marked below.`);
    if (counts.unsupported) {
      blockers.push(
        `${plural(counts.unsupported, "claim")} ${counts.unsupported === 1 ? "is" : "are"} not supported by the experience bank.`,
      );
    }
    if (bankChanged.size) {
      blockers.push(
        `The experience bank changed for ${[...bankChanged].join(", ")}. Check the CV again.`,
      );
    } else if (!cvState.current) {
      blockers.push(
        verification
          ? "The CV changed since it was checked. Check it again."
          : "The CV has not been checked yet.",
      );
    } else if (unverified) {
      blockers.push(`${plural(unverified, "claim")} not verified yet. Check the CV again.`);
    }
    if (cvState.current && !cvState.pdfSha256)
      blockers.push("There is no PDF of this exact CV yet. Check the CV again.");
    if (state === "tailoring" && blockers.length === 0)
      blockers.push("Check the CV again to move it to Ready.");

    let base: CvView["base"] = null;
    const baseId = front.success ? front.data.base : typeof raw.base === "string" ? raw.base : null;
    if (baseId) {
      let label = baseId;
      let changed = false;
      try {
        const detail = await this.#d.profile.readBase(baseId);
        label = detail.summary.label;
        changed = front.success && detail.sha256 !== front.data.base_sha256;
      } catch {
        // The base was deleted or renamed since; the copy in cv.base.md still documents it.
      }
      base = { id: baseId, label, changedSinceTailoring: changed };
    }

    return {
      text,
      sha256: sha256(text),
      issues: parseIssues,
      base,
      headline: front.success
        ? (front.data.headline ?? null)
        : typeof raw.headline === "string"
          ? raw.headline
          : null,
      theme: front.success ? front.data.theme : "classic",
      generatedAt: front.success ? front.data.generated_at : null,
      notes: front.success ? (front.data.notes ?? null) : null,
      rows,
      checks: { issues: allChecks, errors },
      verification: {
        state: !verification ? "none" : cvState.current ? "current" : "stale",
        checkedAt: verification?.checked_at ?? null,
        ...counts,
        unverified,
      },
      render: verification?.render
        ? { ...verification.render, current: cvState.pdfSha256 !== null }
        : null,
      evidence: this.#evidence(
        claims.flatMap((c) => c.ev),
        index,
      ),
      bankChanged: [...bankChanged],
      approve: {
        allowed: blockers.length === 0,
        blockers,
        needsOverride: score !== null && score < threshold,
        score,
        threshold,
      },
    };
  }

  async cvPdf(id: string): Promise<Buffer> {
    this.#record(id);
    try {
      return await readFile(this.#path(id, JOB_FILES.cvPdf));
    } catch (error) {
      if (isNotFound(error)) throw new HttpError(404, "no-pdf", "There is no PDF yet.");
      throw error;
    }
  }

  // ---------- Approve ----------

  async approve(id: string, overrideReason?: string): Promise<JobRecord> {
    const view = await this.cvView(id);
    if (!view.approve.allowed) {
      throw new HttpError(
        409,
        "not-approvable",
        view.approve.blockers[0] ?? "This CV cannot be approved yet.",
      );
    }
    if (view.approve.needsOverride && !overrideReason?.trim()) {
      throw new HttpError(
        400,
        "reason-required",
        `The fit score ${view.approve.score} is below your threshold of ${view.approve.threshold}. Add a short reason to approve anyway.`,
      );
    }
    const cvState = await readCvState(this.#d.root, id);
    if (!cvState.pdfSha256)
      throw new HttpError(409, "no-pdf", "There is no PDF of this exact CV yet.");
    return this.#d.jobs.approve(id, {
      cvSha256: cvState.pdfSha256,
      base: view.base?.id ?? this.#record(id).status?.base ?? "base",
      overrideReason: view.approve.needsOverride ? overrideReason?.trim() : undefined,
    });
  }

  // ---------- Cover letter (M4) ----------

  #requireLetterable(record: JobRecord): void {
    const state = record.status?.state ?? "found";
    if (record.status?.application || !isPreApply(state)) {
      throw new HttpError(
        409,
        "applied",
        "The application was sent; its cover letter can no longer change.",
      );
    }
    if (state === "found" || !record.evaluation) {
      throw new HttpError(
        409,
        "not-evaluated",
        "Evaluate the job first: the letter works from its requirements.",
      );
    }
  }

  /** Writes (or, with feedback, revises) the cover letter, then checks it like the CV. */
  startCoverLetter(
    id: string,
    body: { angle: CoverLetterAngle; feedback?: string | undefined },
  ): TaskInfo {
    const record = this.#record(id);
    this.#requireLetterable(record);
    if (body.feedback && !record.files.includes(JOB_FILES.coverLetter)) {
      throw new HttpError(409, "no-cover-letter", "There is no cover letter to change yet.");
    }
    return this.#d.tasks.start(
      "cover-letter",
      `${body.feedback ? "Revising" : "Writing"} the cover letter for ${record.summary.company}`,
      async (ctx) => {
        const bank = this.#requireConfirmed(await this.#bank());
        const current = this.#record(id);
        const contact = (await this.#d.profile.contact()).value;
        const cvText = await readTextFile(this.#path(id, JOB_FILES.cv));
        const cvFront = cvText
          ? TailoredCvFrontmatter.safeParse(parseCv(cvText).doc.frontmatter)
          : null;
        const currentLetter = body.feedback
          ? await readTextFile(this.#path(id, JOB_FILES.coverLetter))
          : null;
        ctx.progress("Writing the cover letter");
        const result = await runTask(
          this.#d.ai,
          coverLetterTask,
          {
            posting: current.posting,
            postingBody: current.postingBody,
            evaluation: current.evaluation,
            cv: cvText ? splitFrontmatter(cvText).body : null,
            bank,
            angle: body.angle,
            name: contact?.name ?? null,
            feedback:
              body.feedback && currentLetter
                ? { text: body.feedback, current: splitFrontmatter(currentLetter).body }
                : undefined,
          },
          { root: this.#d.root, jobId: id, signal: ctx.signal, onProgress: ctx.aiProgress },
        );
        ctx.addUsage(result.usage);
        const out = result.output;
        const front: CoverLetterFrontmatter = {
          job: id,
          angle: body.angle,
          greeting: out.greeting.trim(),
          closing: out.closing.trim(),
          generated_at: localIsoDateTime(),
          engine: { id: result.engine, model: result.model },
          theme: cvFront?.success ? cvFront.data.theme : "classic",
          ...(out.notes.trim() ? { notes: out.notes.trim() } : {}),
        };
        await writeFileAtomic(
          this.#path(id, JOB_FILES.coverLetter),
          joinFrontmatter(front, out.body),
        );
        return checkSummary(await this.#check(id, ctx, "cover-letter"));
      },
      { jobId: id },
    );
  }

  startCoverLetterCheck(id: string): TaskInfo {
    const record = this.#record(id);
    if (!record.files.includes(JOB_FILES.coverLetter)) {
      throw new HttpError(409, "no-cover-letter", "There is no cover letter to check yet.");
    }
    return this.#d.tasks.start(
      "check-cover-letter",
      `Checking the cover letter for ${record.summary.company}`,
      async (ctx) => checkSummary(await this.#check(id, ctx, "cover-letter")),
      { jobId: id },
    );
  }

  async saveCoverLetter(
    id: string,
    text: string,
    expectedSha256: string | null,
  ): Promise<TaskInfo> {
    const record = this.#record(id);
    this.#requireLetterable(record);
    if (this.#d.tasks.runningForJob(id)) {
      throw new HttpError(
        409,
        "job-busy",
        "Something is already running for this job. Wait for it to finish.",
      );
    }
    await this.#d.jobs.locked(id, async () => {
      const current = await readTextFile(this.#path(id, JOB_FILES.coverLetter));
      if (current === null)
        throw new HttpError(404, "no-cover-letter", "There is no cover letter yet.");
      if (sha256(current) !== expectedSha256) {
        throw new HttpError(
          409,
          "changed-on-disk",
          "cover-letter.md changed since you opened it (in another tab or an editor). Reload to see the latest version.",
        );
      }
      await writeFileAtomic(this.#path(id, JOB_FILES.coverLetter), text.replace(/\r\n?/g, "\n"));
    });
    await this.#reload(id);
    return this.startCoverLetterCheck(id);
  }

  async coverLetterView(id: string): Promise<CoverLetterView> {
    const record = this.#record(id);
    const prefs = (await this.#d.profile.preferences()).value;
    const policy = prefs?.cover_letter.policy ?? "when-requested";
    const text = await readTextFile(this.#path(id, JOB_FILES.coverLetter));
    if (text === null) throw new HttpError(404, "no-cover-letter", "There is no cover letter yet.");
    const { doc, issues: parseIssues } = parseCv(text);
    const front = CoverLetterFrontmatter.safeParse(doc.frontmatter);
    const state = await readDocState(this.#d.root, id, COVER_LETTER_FILES);
    const bankState = await this.#bank();
    const { index } = bankState;
    const formatIssues = this.#formatIssues(doc, parseIssues, "cover-letter");
    const live = checkTailoredCv(doc, bankState.bank, {
      context: postingText(record.posting, record.postingBody),
    });
    const claims = cvClaims(doc);
    const { views, counts, unverified, bankChanged } = this.#claimViews(
      claims,
      state,
      index,
      live.issues,
      () => ({ diff: "same" }),
    );
    const rows = buildRows(doc.blocks, views, new Map(), []);
    const allChecks = [...formatIssues, ...live.issues];
    const errors = emptyCheckCounts();
    for (const i of allChecks) if (i.severity === "error") errors[i.check] += 1;
    const failed = Object.entries(errors)
      .filter(([, n]) => n > 0)
      .map(([check]) => check);

    const approval = record.status?.cover_letter_approval ?? null;
    const approvedNow = approval !== null && approval.sha256 === state.pdfSha256;
    const blockers: string[] = [];
    if (record.status?.application) blockers.push("The application was sent.");
    else if (approvedNow) blockers.push("Already approved.");
    if (failed.length)
      blockers.push(`Checks failed: ${failed.join(", ")}. Fix the paragraphs marked below.`);
    if (counts.unsupported) {
      blockers.push(
        `${plural(counts.unsupported, "statement")} ${counts.unsupported === 1 ? "is" : "are"} not supported by the experience bank or the posting.`,
      );
    }
    if (bankChanged.size) {
      blockers.push(
        `The experience bank changed for ${[...bankChanged].join(", ")}. Check the letter again.`,
      );
    } else if (!state.current) {
      blockers.push(
        state.verification
          ? "The letter changed since it was checked. Check it again."
          : "The letter has not been checked yet.",
      );
    } else if (unverified) {
      blockers.push(`${plural(unverified, "paragraph")} not verified yet. Check the letter again.`);
    }
    if (state.current && !state.pdfSha256)
      blockers.push("There is no PDF of this exact letter yet.");

    return {
      text,
      sha256: sha256(text),
      angle: front.success ? front.data.angle : null,
      greeting: front.success ? front.data.greeting : null,
      closing: front.success ? front.data.closing : null,
      generatedAt: front.success ? front.data.generated_at : null,
      notes: front.success ? (front.data.notes ?? null) : null,
      rows,
      checks: { issues: allChecks, errors },
      verification: {
        state: !state.verification ? "none" : state.current ? "current" : "stale",
        checkedAt: state.verification?.checked_at ?? null,
        ...counts,
        unverified,
      },
      render: state.verification?.render
        ? { ...state.verification.render, current: state.pdfSha256 !== null }
        : null,
      evidence: this.#evidence(
        claims.flatMap((c) => c.ev),
        index,
      ),
      approval: approval ? { ...approval, current: approvedNow } : null,
      approve: { allowed: blockers.length === 0, blockers },
      policy,
    };
  }

  async coverLetterPdf(id: string): Promise<Buffer> {
    this.#record(id);
    try {
      return await readFile(this.#path(id, JOB_FILES.coverLetterPdf));
    } catch (error) {
      if (isNotFound(error))
        throw new HttpError(404, "no-pdf", "There is no cover letter PDF yet.");
      throw error;
    }
  }

  /** The cover letter has its own approval, locked to the SHA-256 of cover-letter.pdf. */
  async approveCoverLetter(id: string): Promise<JobRecord> {
    const view = await this.coverLetterView(id);
    if (!view.approve.allowed) {
      throw new HttpError(
        409,
        "not-approvable",
        view.approve.blockers[0] ?? "This letter cannot be approved yet.",
      );
    }
    const state = await readDocState(this.#d.root, id, COVER_LETTER_FILES);
    if (!state.pdfSha256)
      throw new HttpError(409, "no-pdf", "There is no PDF of this exact letter yet.");
    return this.#d.jobs.approveCoverLetter(id, state.pdfSha256);
  }
}

function checkSummary(file: VerificationFile) {
  const count = (verdict: VerifiedClaim["verdict"]) =>
    file.claims.filter((c) => c.verdict === verdict).length;
  return {
    checkErrors: file.checks.filter((c) => c.severity === "error").length,
    supported: count("supported"),
    weakened: count("weakened"),
    unsupported: count("unsupported"),
    pages: file.render?.pages ?? null,
  };
}

/** The CV as rows for the review: sections and claims in order, removed base claims in place. */
function buildRows(
  blocks: readonly Block[],
  views: ClaimView[],
  removedBefore: Map<number, ClaimDiff[]>,
  trailing: ClaimDiff[],
): CvRow[] {
  const rows: CvRow[] = [];
  let n = 0;
  const pushClaim = (inline: ClaimView["inline"]) => {
    const view = views[n];
    if (!view) return;
    for (const d of removedBefore.get(n) ?? []) {
      if (d.op === "removed") rows.push({ t: "removed", text: d.base.text, ev: d.base.ev });
    }
    rows.push({ t: "claim", claim: { ...view, inline } });
    n++;
  };
  for (const block of blocks) {
    if (block.t === "section") {
      rows.push({ t: "section", text: inlinePlain(block.text).trim(), line: block.line });
    } else if (block.t === "entry" || block.t === "paragraph") pushClaim(block.text);
    else if (block.t === "list") for (const item of block.items) pushClaim(item.text);
  }
  for (const d of trailing) {
    if (d.op === "removed") rows.push({ t: "removed", text: d.base.text, ev: d.base.ev });
  }
  return rows;
}
