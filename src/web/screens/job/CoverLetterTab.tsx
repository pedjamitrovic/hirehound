import { useEffect, useRef, useState } from "preact/hooks";
import { replaceClaimText } from "../../../shared/cv/edit.ts";
import { COVER_LETTER_ANGLES } from "../../../shared/enums.ts";
import type { ClaimView, CoverLetterView, JobDetail } from "../../../shared/schemas/api.ts";
import { api, errorMessage } from "../../api.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { AiReadiness, useAiReady } from "../../components/TaskStatus.tsx";
import { EmptyState, formatDateTime, Kbd, Link, Notice } from "../../components/ui.tsx";
import { jobPath } from "../../router.ts";
import { jobRevisions, upsertJob } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";
import { ChecksSummary, ClaimRow } from "./CvTab.tsx";
import { JobTaskStatus, useJobTask } from "./parts.tsx";

type Angle = (typeof COVER_LETTER_ANGLES)[number];

const ANGLES: Record<Angle, { label: string; hint: string }> = {
  fit: { label: "Why I fit", hint: "The posting's key requirements, each with evidence." },
  impact: { label: "Impact first", hint: "Opens with your strongest measurable results." },
  motivation: { label: "Why this team", hint: "What in the posting draws you, then the evidence." },
  brief: { label: "Short note", hint: "Three short paragraphs." },
};

const POLICY: Record<CoverLetterView["policy"], string> = {
  always: "Your policy: always send a cover letter.",
  "when-requested": "Your policy: only when the application asks for one.",
  never: "Your policy: no cover letters. You can still write one for this job.",
};

function useLetter(id: string, exists: boolean) {
  const [view, setView] = useState<CoverLetterView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = jobRevisions.value.get(id) ?? 0;
  useEffect(() => {
    if (!exists) {
      setView(null);
      return;
    }
    let cancelled = false;
    api.coverLetter(id).then(
      (v) => {
        if (!cancelled) {
          setView(v);
          setError(null);
        }
      },
      (e) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, revision, exists]);
  return { view, error };
}

function AngleSelect(props: { value: Angle; onChange: (angle: Angle) => void }) {
  return (
    <select
      class="select"
      aria-label="Angle"
      value={props.value}
      title={ANGLES[props.value].hint}
      onChange={(e) => props.onChange(e.currentTarget.value as Angle)}
    >
      {COVER_LETTER_ANGLES.map((a) => (
        <option key={a} value={a}>
          {ANGLES[a].label}
        </option>
      ))}
    </select>
  );
}

function RewriteDialog(props: { id: string; angle: Angle; onClose: () => void }) {
  const [angle, setAngle] = useState<Angle>(props.angle);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.writeCoverLetter(props.id, {
        angle,
        ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
      });
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Rewrite the cover letter"
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" class="btn primary" disabled={busy} onClick={() => void submit()}>
            {feedback.trim() ? "Revise it" : "Write it again"} <Kbd keys="mod+enter" />
          </button>
        </>
      }
    >
      <div class="field">
        <span>Angle</span>
        <AngleSelect value={angle} onChange={setAngle} />
        <span class="muted small-print">{ANGLES[angle].hint}</span>
      </div>
      <label class="field">
        <span>What should change? (optional)</span>
        <textarea
          class="textarea"
          rows={4}
          placeholder="Shorter, and mention the on-call work"
          value={feedback}
          onInput={(e) => setFeedback(e.currentTarget.value)}
        />
      </label>
      <p class="muted">
        With a note, Claude revises the current letter; without one it writes a new letter. Either
        way, every paragraph is checked again.
      </p>
    </Dialog>
  );
}

function Letter(props: {
  detail: JobDetail;
  view: CoverLetterView;
  onChange: (d: JobDetail) => void;
}) {
  const { detail, view } = props;
  const id = detail.summary.id;
  const task = useJobTask(id);
  const running = task?.state === "running";
  const [editing, setEditing] = useState<string | null>(null);
  const [rewrite, setRewrite] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const editor = useRef<HTMLTextAreaElement>(null);
  const sent = Boolean(detail.status?.application);

  useEffect(() => {
    const problems = new Set<number>();
    for (const row of view.rows) {
      if (
        row.t === "claim" &&
        (row.claim.verdict === "weakened" || row.claim.verdict === "unsupported")
      ) {
        problems.add(row.claim.n);
      }
    }
    setOpen(problems);
  }, [view.sha256, view.verification.checkedAt]);

  useEffect(() => {
    if (editing !== null) editor.current?.focus();
  }, [editing !== null]);

  const save = async (text: string) => {
    try {
      await api.saveCoverLetter(id, text, view.sha256);
      setEditing(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const useSuggestion = (claim: ClaimView) => {
    if (!claim.suggestion) return;
    const next = replaceClaimText(view.text, claim.line, claim.kind, claim.suggestion);
    if (next) void save(next);
    else toast("That paragraph changed. Edit the letter to apply the suggestion.", "error");
  };

  return (
    <div class="review">
      <div class="review-bar">
        <span class="badge">{view.angle ? ANGLES[view.angle].label : "Cover letter"}</span>
        {view.generatedAt ? (
          <span class="muted">Written {formatDateTime(view.generatedAt)}</span>
        ) : null}
        <span class="muted small-print">{POLICY[view.policy]}</span>
        <span class="spacer" />
        <button
          type="button"
          class="btn small"
          disabled={running || sent}
          onClick={() => setRewrite(true)}
        >
          Rewrite
        </button>
        <button
          type="button"
          class="btn small"
          disabled={running || sent}
          onClick={() => setEditing(view.text)}
        >
          Edit
        </button>
        <button
          type="button"
          class="btn small"
          disabled={running}
          onClick={() => api.checkCoverLetter(id).catch((e) => toast(errorMessage(e), "error"))}
        >
          Check again
        </button>
        <a class="btn small" href={api.coverLetterPdfUrl(id, true)}>
          <Icon name="external" size={12} /> Download PDF
        </a>
      </div>
      <JobTaskStatus task={task} />
      {view.notes ? (
        <Notice>
          <strong>From the writing:</strong> {view.notes}
        </Notice>
      ) : null}
      <div class="letter-panes">
        <section class="review-cv" aria-label="Cover letter">
          {editing !== null ? (
            <div class="cv-editor">
              <textarea
                ref={editor}
                class="textarea mono base-text"
                spellcheck={false}
                aria-label="cover-letter.md"
                value={editing}
                onInput={(e) => setEditing(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save(editing);
                  } else if (e.key === "Escape") setEditing(null);
                }}
              />
              <div class="cv-editor-bar">
                <button
                  type="button"
                  class="btn primary"
                  disabled={editing === view.text}
                  onClick={() => void save(editing)}
                >
                  Save and check <Kbd keys="mod+enter" />
                </button>
                <button type="button" class="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <span class="muted">Paragraphs only, each keeping its evidence marker.</span>
              </div>
            </div>
          ) : (
            <div class="cv-rows letter-rows">
              {view.greeting ? <p class="letter-line">{view.greeting}</p> : null}
              {view.rows.map((row) =>
                row.t === "claim" ? (
                  <ClaimRow
                    key={row.claim.n}
                    claim={row.claim}
                    view={view}
                    showDiff={false}
                    highlight={false}
                    open={open.has(row.claim.n)}
                    onToggle={() => {
                      const next = new Set(open);
                      if (next.has(row.claim.n)) next.delete(row.claim.n);
                      else next.add(row.claim.n);
                      setOpen(next);
                    }}
                    onUseSuggestion={useSuggestion}
                  />
                ) : row.t === "section" ? (
                  <h3 key={`s${row.line}`} class="cv-section-title">
                    {row.text}
                  </h3>
                ) : null,
              )}
              {view.closing ? <p class="letter-line">{view.closing}</p> : null}
            </div>
          )}
        </section>
        <section class="review-pdf" aria-label="PDF">
          {view.render ? (
            <>
              {!view.render.current ? (
                <Notice kind="warning">
                  This PDF is of an earlier version. Check the letter again.
                </Notice>
              ) : null}
              <iframe
                key={view.render.pdf_sha256}
                class="cv-frame"
                title="Cover letter PDF"
                src={`${api.coverLetterPdfUrl(id, false, view.render.pdf_sha256)}#view=FitH&navpanes=0`}
              />
            </>
          ) : (
            <EmptyState icon="alert" title="No PDF yet" compact>
              Check the letter again to render it.
            </EmptyState>
          )}
        </section>
      </div>
      <section class="approve-bar" aria-label="Cover letter actions">
        <ChecksSummary view={view} />
        <div class="approve-row">
          {view.approval?.current ? (
            <span class="badge success">
              <Icon name="check" size={12} /> Approved {formatDateTime(view.approval.at)}
            </span>
          ) : view.approval ? (
            <span class="blocker warning-text">
              The letter changed after you approved it. Approve this version to send it.
            </span>
          ) : null}
          {!view.approve.allowed && view.approve.blockers[0] && !view.approval?.current ? (
            <span class="blocker">
              <Icon name="alert" size={13} /> {view.approve.blockers[0]}
            </span>
          ) : null}
          <span class="spacer" />
          <button
            type="button"
            class="btn primary"
            disabled={!view.approve.allowed || running}
            title={view.approve.blockers.join("\n") || undefined}
            onClick={async () => {
              try {
                const next = await api.approveCoverLetter(id);
                props.onChange(next);
                upsertJob(next.summary);
                toast("Cover letter approved, locked to this exact PDF.", "success");
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            }}
          >
            Approve the letter
          </button>
        </div>
      </section>
      {rewrite ? (
        <RewriteDialog id={id} angle={view.angle ?? "fit"} onClose={() => setRewrite(false)} />
      ) : null}
    </div>
  );
}

export function CoverLetterTab(props: { detail: JobDetail; onChange: (d: JobDetail) => void }) {
  const { detail } = props;
  const id = detail.summary.id;
  const exists = detail.files.includes("cover-letter.md");
  const { view, error } = useLetter(id, exists);
  const [angle, setAngle] = useState<Angle>("fit");
  const task = useJobTask(id);
  const aiReady = useAiReady();
  const running = task?.state === "running";
  if (error) return <Notice kind="danger">{error}</Notice>;
  if (exists && !view) return <div class="empty compact muted">Loading the cover letter...</div>;
  if (view) return <Letter detail={detail} view={view} onChange={props.onChange} />;

  const evaluated = detail.summary.state !== "found" && detail.summary.score !== null;
  const sent = Boolean(detail.status?.application);
  return (
    <div class="job-tab">
      <JobTaskStatus task={task} />
      <AiReadiness ready={aiReady} />
      <section class="card">
        <EmptyState
          icon="note"
          title="No cover letter"
          actions={
            sent ? null : evaluated ? (
              <div class="tailor-action">
                <AngleSelect value={angle} onChange={setAngle} />
                <button
                  type="button"
                  class="btn primary"
                  disabled={running || aiReady === false}
                  onClick={() =>
                    api
                      .writeCoverLetter(id, { angle })
                      .catch((e) => toast(errorMessage(e), "error"))
                  }
                >
                  Write the cover letter
                </button>
              </div>
            ) : (
              <Link class="btn" href={jobPath(id, "evaluation")}>
                Evaluate first
              </Link>
            )
          }
        >
          {ANGLES[angle].hint} Every paragraph cites your experience bank and is checked like the
          CV; statements about the company may only use what the posting says.
        </EmptyState>
      </section>
    </div>
  );
}
