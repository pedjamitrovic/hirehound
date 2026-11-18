import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { CHECK_IDS, type CheckId } from "../../../shared/cv/checks.ts";
import { replaceClaimText } from "../../../shared/cv/edit.ts";
import type { ClaimView, CvView, EvaluationView, JobDetail } from "../../../shared/schemas/api.ts";
import { api, errorMessage } from "../../api.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { AiReadiness, useAiReady } from "../../components/TaskStatus.tsx";
import { EmptyState, formatDateTime, Kbd, Link, Notice } from "../../components/ui.tsx";
import { useHotkeys } from "../../hotkeys.ts";
import { jobPath, navigate } from "../../router.ts";
import { openMove } from "../../state/actions.ts";
import { jobList, jobRevisions, upsertJob } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";
import { TailorAction } from "./EvaluationTab.tsx";
import {
  EvidenceChips,
  InlineText,
  JobTaskStatus,
  plural,
  useJobTask,
  VERDICT_LABELS,
} from "./parts.tsx";

const CHECK_LABELS: Record<CheckId, string> = {
  format: "Format",
  evidence: "Evidence",
  numbers: "Numbers",
  companies: "Companies",
  titles: "Titles",
  dates: "Dates",
};

function useCv(id: string): { view: CvView | null; error: string | null; reload: () => void } {
  const [view, setView] = useState<CvView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const revision = jobRevisions.value.get(id) ?? 0;
  useEffect(() => {
    let cancelled = false;
    api.cv(id).then(
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
  }, [id, revision, nonce]);
  return { view, error, reload: () => setNonce((n) => n + 1) };
}

function useEvaluation(id: string): EvaluationView | null {
  const [view, setView] = useState<EvaluationView | null>(null);
  const revision = jobRevisions.value.get(id) ?? 0;
  useEffect(() => {
    api.evaluation(id).then(setView, () => setView(null));
  }, [id, revision]);
  return view;
}

// ---------- Claim rows ----------

export function ClaimRow(props: {
  claim: ClaimView;
  view: Pick<CvView, "evidence">;
  showDiff: boolean;
  highlight: boolean;
  open: boolean;
  onToggle: () => void;
  onUseSuggestion: (claim: ClaimView) => void;
}) {
  const { claim, view, showDiff } = props;
  const problem = claim.verdict === "weakened" || claim.verdict === "unsupported";
  const failed = claim.issues.some((i) => i.severity === "error");
  return (
    <div
      class="claim"
      data-kind={claim.kind}
      data-diff={showDiff ? claim.diff : undefined}
      data-verdict={claim.verdict ?? "unverified"}
      data-failed={failed ? "true" : undefined}
      data-highlight={props.highlight ? "true" : undefined}
    >
      <span class="claim-mark" aria-hidden="true">
        {showDiff ? (claim.diff === "added" ? "+" : claim.diff === "changed" ? "~" : "") : ""}
      </span>
      <div class="claim-body">
        <div class="claim-text">
          <InlineText nodes={claim.inline} />
        </div>
        {showDiff && claim.diff === "changed" && claim.baseText ? (
          <div class="claim-was">
            <span class="muted">Base:</span> <del>{claim.baseText}</del>
          </div>
        ) : null}
        <div class="claim-meta">
          <EvidenceChips ids={claim.ev} evidence={view.evidence} />
          <button
            type="button"
            class={`verdict verdict-${claim.verdict ?? "unverified"}`}
            aria-expanded={problem || claim.reason ? props.open : undefined}
            onClick={props.onToggle}
            title={claim.reason ?? "Not verified yet"}
          >
            {claim.verdict ? VERDICT_LABELS[claim.verdict] : "Not verified"}
          </button>
        </div>
        {claim.issues.map((issue, i) => (
          <div key={i} class={`claim-issue ${issue.severity}`}>
            <Icon name="alert" size={12} /> {issue.message}
          </div>
        ))}
        {props.open && claim.reason ? (
          <div class={`claim-detail${problem ? " problem" : ""}`}>
            <div>{claim.reason}</div>
            {claim.suggestion ? (
              <div class="claim-suggestion">
                <span class="muted">Suggested:</span> {claim.suggestion}
                <button
                  type="button"
                  class="btn small"
                  onClick={() => props.onUseSuggestion(claim)}
                >
                  Use this wording
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Dialogs ----------

function FeedbackDialog(props: { id: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await api.tailor(props.id, { feedback: text.trim() });
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Request changes"
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!text.trim() || busy}
            onClick={() => void submit()}
          >
            Revise the CV <Kbd keys="mod+enter" />
          </button>
        </>
      }
    >
      <label class="field">
        <span>What should be different?</span>
        <textarea
          class="textarea"
          rows={5}
          autoFocus
          placeholder="Lead with the Kubernetes migration, shorten the Globex role, drop the skills paragraph."
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <p class="muted">
        Claude revises the current CV within the same rules: only confirmed facts, every claim
        cited. The checks and the verifier run again afterwards.
      </p>
    </Dialog>
  );
}

function BaseDialog(props: {
  id: string;
  current: string | null;
  bases: { id: string; label: string }[];
  onClose: () => void;
}) {
  const [base, setBase] = useState(
    props.bases.find((b) => b.id !== props.current)?.id ?? props.current ?? "",
  );
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!base || busy) return;
    setBusy(true);
    try {
      await api.tailor(props.id, { base });
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Switch base CV"
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!base || busy}
            onClick={() => void submit()}
          >
            Tailor from this base
          </button>
        </>
      }
    >
      <label class="field">
        <span>Base CV</span>
        <select class="select" value={base} onChange={(e) => setBase(e.currentTarget.value)}>
          {props.bases.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
              {b.id === props.current ? " (current)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p class="muted">The CV is tailored again from scratch; the current version is replaced.</p>
    </Dialog>
  );
}

function ApproveDialog(props: {
  view: CvView;
  detail: JobDetail;
  onClose: () => void;
  onApproved: (detail: JobDetail) => void;
}) {
  const { view } = props;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const needsReason = view.approve.needsOverride;
  const submit = async () => {
    if (busy || (needsReason && !reason.trim())) return;
    setBusy(true);
    try {
      const detail = await api.approve(
        props.detail.summary.id,
        needsReason ? { overrideReason: reason.trim() } : {},
      );
      props.onApproved(detail);
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Approve this CV"
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={busy || (needsReason && !reason.trim())}
            onClick={() => void submit()}
            // biome-ignore lint/a11y/noAutofocus: Enter approves when no reason is needed
            autoFocus={!needsReason}
          >
            Approve
          </button>
        </>
      }
    >
      <p>
        The approval is locked to this exact PDF
        {view.render ? (
          <>
            {" "}
            (SHA-256 <code>{view.render.pdf_sha256.slice(0, 12)}</code>,{" "}
            {plural(view.render.pages, "page")})
          </>
        ) : null}
        . If the file changes afterwards, applying is refused until you approve again.
      </p>
      {view.verification.weakened ? (
        <Notice kind="warning">
          {plural(view.verification.weakened, "claim")}{" "}
          {view.verification.weakened === 1 ? "is" : "are"} weakened: supported, but stated more
          strongly than the evidence.
        </Notice>
      ) : null}
      {needsReason ? (
        <label class="field">
          <span>
            The fit score {view.approve.score} is below your threshold of {view.approve.threshold}.
            Why apply anyway?
          </span>
          <textarea
            class="textarea"
            rows={3}
            autoFocus
            value={reason}
            placeholder="Referral from the hiring manager"
            onInput={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      ) : null}
    </Dialog>
  );
}

// ---------- The review ----------

export function ChecksSummary(props: { view: Pick<CvView, "checks" | "verification" | "render"> }) {
  const { view } = props;
  const v = view.verification;
  return (
    <div class="checks-summary">
      <span class="checks-group" title="Deterministic checks against the cited bank entries">
        {CHECK_IDS.map((check) => {
          const errors = view.checks?.errors[check] ?? 0;
          return (
            <span key={check} class={`check ${errors ? "fail" : "ok"}`}>
              <Icon name={errors ? "close" : "check"} size={11} />
              {CHECK_LABELS[check]}
              {errors ? ` ${errors}` : ""}
            </span>
          );
        })}
      </span>
      <span class="checks-group" title="Faithfulness verifier">
        Verifier: <strong>{v.supported}</strong> supported
        {v.weakened ? (
          <>
            , <strong class="warning-text">{v.weakened}</strong> weakened
          </>
        ) : null}
        {v.unsupported ? (
          <>
            , <strong class="danger-text">{v.unsupported}</strong> unsupported
          </>
        ) : null}
        {v.unverified ? <>, {v.unverified} not verified</> : null}
      </span>
      {view.render ? (
        <>
          <span class="checks-group">
            PDF: {plural(view.render.pages, "page")}
            {view.render.pages > view.render.max_pages ? (
              <strong class="warning-text"> (limit {view.render.max_pages})</strong>
            ) : null}
          </span>
          <span
            class="checks-group"
            title="Share of the CV's words read back out of the PDF, as an ATS would"
          >
            ATS read-back:{" "}
            <strong class={view.render.ats.coverage < 0.98 ? "warning-text" : undefined}>
              {Math.floor(view.render.ats.coverage * 100)}%
            </strong>
          </span>
        </>
      ) : null}
    </div>
  );
}

function CvReview(props: { detail: JobDetail; onChange: (detail: JobDetail) => void }) {
  const { detail } = props;
  const id = detail.summary.id;
  const { view, error, reload } = useCv(id);
  const evaluation = useEvaluation(id);
  const task = useJobTask(id);
  const running = task?.state === "running";
  const aiReady = useAiReady();
  const [showDiff, setShowDiff] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [openClaims, setOpenClaims] = useState<ReadonlySet<number>>(new Set());
  const [focusReq, setFocusReq] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"feedback" | "base" | "approve" | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const state = detail.summary.state;
  const approved = state === "approved";
  const queue = jobList.value.filter((j) => j.state === "ready");
  const position = queue.findIndex((j) => j.id === id);

  const highlighted = useMemo(() => {
    const req = evaluation?.evaluation?.fit.requirements.find((r) => r.id === focusReq);
    return new Set(req?.evidence ?? []);
  }, [evaluation, focusReq]);

  // Problems open by default; the rest open on click.
  useEffect(() => {
    if (!view) return;
    const open = new Set<number>();
    for (const row of view.rows) {
      if (
        row.t === "claim" &&
        (row.claim.verdict === "weakened" || row.claim.verdict === "unsupported")
      ) {
        open.add(row.claim.n);
      }
    }
    setOpenClaims(open);
  }, [view?.sha256, view?.verification.checkedAt]);

  const save = async (text: string, sha: string) => {
    try {
      await api.saveCv(id, text, sha);
      setEditing(null);
    } catch (e) {
      toast(errorMessage(e), "error");
      reload();
    }
  };

  const useSuggestion = (claim: ClaimView) => {
    if (!view || !claim.suggestion) return;
    const next = replaceClaimText(view.text, claim.line, claim.kind, claim.suggestion);
    if (next === null) {
      toast("That line changed. Edit the CV to apply the suggestion.", "error");
      return;
    }
    void save(next, view.sha256);
  };

  const canEdit = !approved && !running && view !== null;
  const canTailor = !approved && !running && aiReady !== false;

  useHotkeys([
    {
      keys: "a",
      group: "CV review",
      description: "Approve",
      enabled: () => Boolean(view?.approve.allowed) && editing === null,
      run: () => setDialog("approve"),
    },
    {
      keys: "r",
      group: "CV review",
      description: "Request changes",
      enabled: () => canTailor && editing === null,
      run: () => setDialog("feedback"),
    },
    {
      keys: "e",
      group: "CV review",
      description: "Edit the CV",
      enabled: () => canEdit && editing === null,
      run: () => {
        if (view) setEditing(view.text);
      },
    },
    {
      keys: "b",
      group: "CV review",
      description: "Switch base CV",
      enabled: () => canTailor && editing === null,
      run: () => setDialog("base"),
    },
    {
      keys: "s",
      group: "CV review",
      description: "Skip this job",
      run: () => openMove([detail.summary], { to: "skipped" }),
    },
    {
      keys: "d",
      group: "CV review",
      description: "Show or hide the diff",
      run: () => setShowDiff((v) => !v),
    },
    {
      keys: "j",
      group: "CV review",
      description: "Next job to review",
      enabled: () => queue.length > 0,
      run: () => {
        const next = queue[position < 0 ? 0 : (position + 1) % queue.length];
        if (next && next.id !== id) navigate(jobPath(next.id, "cv"));
      },
    },
    {
      keys: "k",
      group: "CV review",
      description: "Previous job to review",
      enabled: () => queue.length > 0,
      run: () => {
        const prev = queue[position <= 0 ? queue.length - 1 : position - 1];
        if (prev && prev.id !== id) navigate(jobPath(prev.id, "cv"));
      },
    },
  ]);

  useEffect(() => {
    const textarea = editor.current;
    if (editing === null || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    textarea.scrollTop = 0;
  }, [editing !== null]);

  if (error) return <Notice kind="danger">{error}</Notice>;
  if (!view) return <div class="empty compact muted">Loading the CV...</div>;

  const requirements = evaluation?.evaluation?.fit.requirements ?? [];
  const bases = evaluation?.bases ?? [];

  return (
    <div class="review">
      <div class="review-bar">
        {position >= 0 ? (
          <span class="badge" title="Jobs in Ready">
            Review {position + 1}/{queue.length} <Kbd keys="j" /> <Kbd keys="k" />
          </span>
        ) : null}
        {view.base ? (
          <span class="muted">
            From base <strong>{view.base.label}</strong>
            {view.generatedAt ? `, ${formatDateTime(view.generatedAt)}` : ""}
          </span>
        ) : null}
        <span class="spacer" />
        <label class="toggle">
          <input type="checkbox" checked={showDiff} onChange={() => setShowDiff((v) => !v)} />
          Diff vs base <Kbd keys="d" />
        </label>
        <button
          type="button"
          class="btn small"
          disabled={running}
          onClick={async () => {
            try {
              await api.checkCv(id);
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          Check again
        </button>
        <a class="btn small" href={api.cvPdfUrl(id)} target="_blank" rel="noopener noreferrer">
          <Icon name="external" size={12} /> PDF
        </a>
      </div>

      <JobTaskStatus task={task} />
      <AiReadiness ready={aiReady} />
      {view.base?.changedSinceTailoring ? (
        <Notice>
          The base CV "{view.base.label}" changed after this CV was tailored. Tailor again to pick
          up the changes.
        </Notice>
      ) : null}
      {view.notes ? (
        <Notice>
          <strong>From the tailoring:</strong> {view.notes}
        </Notice>
      ) : null}

      <div class="review-panes">
        <aside class="review-reqs" aria-label="Requirements">
          <h3>Requirements</h3>
          {requirements.length === 0 ? <p class="muted">No evaluation.</p> : null}
          <ul>
            {requirements.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  class="req"
                  data-match={r.match}
                  aria-pressed={focusReq === r.id}
                  onClick={() => setFocusReq(focusReq === r.id ? null : r.id)}
                  title={r.quote ? `"${r.quote}"` : r.text}
                >
                  <span class={`weight weight-${r.weight}`}>{r.weight}</span>
                  <span class="req-label">{r.text}</span>
                  <span class={`match match-${r.match}`}>
                    <Icon name={r.match === "gap" ? "close" : "check"} size={11} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {requirements.length ? (
            <p class="muted small-print">
              Click a requirement to highlight the lines that cover it.
            </p>
          ) : null}
        </aside>

        <section class="review-cv" aria-label="Tailored CV">
          {editing !== null ? (
            <div class="cv-editor">
              <textarea
                ref={editor}
                class="textarea mono base-text"
                spellcheck={false}
                aria-label="cv.md"
                value={editing}
                onInput={(e) => setEditing(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save(editing, view.sha256);
                  } else if (e.key === "Escape") {
                    setEditing(null);
                  }
                }}
              />
              <div class="cv-editor-bar">
                <button
                  type="button"
                  class="btn primary"
                  disabled={editing === view.text}
                  onClick={() => void save(editing, view.sha256)}
                >
                  Save and check <Kbd keys="mod+enter" />
                </button>
                <button type="button" class="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <span class="muted">
                  Every claim keeps its <code>{"<!-- ev: ... -->"}</code> marker. Saving runs the
                  checks again; only changed lines go back to the verifier.
                </span>
              </div>
            </div>
          ) : (
            <div class="cv-rows">
              {view.headline ? <div class="cv-headline">{view.headline}</div> : null}
              {view.issues
                .filter((i) => i.severity === "error")
                .map((i) => (
                  <Notice key={`${i.line}:${i.message}`} kind="danger">
                    Line {i.line}: {i.message}
                  </Notice>
                ))}
              {view.rows.map((row, i) => {
                if (row.t === "section") {
                  return (
                    <h3 key={`s${i}`} class="cv-section-title">
                      {row.text}
                    </h3>
                  );
                }
                if (row.t === "removed") {
                  return showDiff ? (
                    <div key={`r${i}`} class="claim" data-diff="removed">
                      <span class="claim-mark" aria-hidden="true">
                        -
                      </span>
                      <div class="claim-body">
                        <div class="claim-text">
                          <del>{row.text}</del>
                        </div>
                        <div class="claim-meta">
                          <EvidenceChips ids={row.ev} evidence={view.evidence} />
                          <span class="muted">Left out</span>
                        </div>
                      </div>
                    </div>
                  ) : null;
                }
                const claim = row.claim;
                return (
                  <ClaimRow
                    key={`c${claim.n}`}
                    claim={claim}
                    view={view}
                    showDiff={showDiff}
                    highlight={claim.ev.some((evId) => highlighted.has(evId))}
                    open={openClaims.has(claim.n)}
                    onToggle={() => {
                      const next = new Set(openClaims);
                      if (next.has(claim.n)) next.delete(claim.n);
                      else next.add(claim.n);
                      setOpenClaims(next);
                    }}
                    onUseSuggestion={useSuggestion}
                  />
                );
              })}
            </div>
          )}
        </section>

        <section class="review-pdf" aria-label="PDF">
          {view.render ? (
            <>
              {!view.render.current ? (
                <Notice kind="warning">
                  This PDF is of an earlier version. Check the CV again.
                </Notice>
              ) : null}
              <iframe
                key={view.render.pdf_sha256}
                class="cv-frame"
                title="CV PDF"
                src={`${api.cvPdfUrl(id, view.render.pdf_sha256)}#view=FitH&navpanes=0`}
              />
            </>
          ) : (
            <EmptyState icon="alert" title="No PDF yet" compact>
              Check the CV again to render it.
            </EmptyState>
          )}
        </section>
      </div>

      <section class="approve-bar" aria-label="Review actions">
        <ChecksSummary view={view} />
        {approved && detail.status?.approval ? (
          <div class="approve-row">
            <span class="badge success">
              <Icon name="check" size={12} /> Approved {formatDateTime(detail.status.approval.at)}
            </span>
            <span class="muted">
              Locked to <code>{detail.status.approval.cv_sha256.slice(0, 12)}</code>
            </span>
            <span class="spacer" />
            <button
              type="button"
              class="btn"
              onClick={async () => {
                try {
                  const next = await api.transition(id, { to: "ready" });
                  props.onChange(next);
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              Revoke approval
            </button>
          </div>
        ) : (
          <div class="approve-row">
            {!view.approve.allowed && view.approve.blockers[0] ? (
              <span class="blocker">
                <Icon name="alert" size={13} /> {view.approve.blockers[0]}
              </span>
            ) : view.approve.needsOverride ? (
              <span class="blocker warning-text">
                Fit {view.approve.score} is below your threshold of {view.approve.threshold}.
              </span>
            ) : (
              <span class="muted">Every check passed.</span>
            )}
            <span class="spacer" />
            <button
              type="button"
              class="btn primary"
              disabled={!view.approve.allowed || running}
              title={view.approve.blockers.join("\n") || undefined}
              onClick={() => setDialog("approve")}
            >
              Approve <kbd>A</kbd>
            </button>
            <button
              type="button"
              class="btn"
              disabled={!canTailor}
              onClick={() => setDialog("feedback")}
            >
              Request changes <kbd>R</kbd>
            </button>
            <button
              type="button"
              class="btn"
              disabled={!canEdit}
              onClick={() => setEditing(view.text)}
            >
              Edit <kbd>E</kbd>
            </button>
            <button
              type="button"
              class="btn"
              disabled={!canTailor || bases.length < 2}
              title={bases.length < 2 ? "You have one base CV" : undefined}
              onClick={() => setDialog("base")}
            >
              Switch base <kbd>B</kbd>
            </button>
            <button
              type="button"
              class="btn ghost"
              onClick={() => openMove([detail.summary], { to: "skipped" })}
            >
              Skip <kbd>S</kbd>
            </button>
          </div>
        )}
      </section>

      {dialog === "feedback" ? <FeedbackDialog id={id} onClose={() => setDialog(null)} /> : null}
      {dialog === "base" ? (
        <BaseDialog
          id={id}
          current={view.base?.id ?? null}
          bases={bases}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "approve" ? (
        <ApproveDialog
          view={view}
          detail={detail}
          onClose={() => setDialog(null)}
          onApproved={(next) => {
            props.onChange(next);
            upsertJob(next.summary);
            toast("Approved. The approval is locked to this exact PDF.", "success");
          }}
        />
      ) : null}
    </div>
  );
}

export function CvTab(props: { detail: JobDetail; onChange: (detail: JobDetail) => void }) {
  const { detail } = props;
  const id = detail.summary.id;
  const task = useJobTask(id);
  const evaluation = useEvaluation(id);
  if (detail.files.includes("cv.md")) return <CvReview detail={detail} onChange={props.onChange} />;
  const evaluated = Boolean(evaluation?.evaluation);
  return (
    <div class="job-tab">
      <JobTaskStatus task={task} />
      <section class="card">
        <EmptyState
          icon="text"
          title="No tailored CV yet"
          actions={
            evaluated && evaluation ? (
              <TailorAction
                detail={detail}
                bases={evaluation.bases}
                suggested={evaluation.evaluation?.level.base ?? null}
                primary
              />
            ) : (
              <Link class="btn" href={jobPath(id, "evaluation")}>
                Evaluate first
              </Link>
            )
          }
        >
          Tailoring starts from a base CV and uses only confirmed facts from your experience bank.
          Every line cites its evidence; deterministic checks and a separate verifier check them
          before the CV can be approved.
        </EmptyState>
      </section>
    </div>
  );
}
