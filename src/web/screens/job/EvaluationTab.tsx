import { useEffect, useState } from "preact/hooks";
import type { EvaluationView, JobDetail } from "../../../shared/schemas/api.ts";
import type { Requirement } from "../../../shared/schemas/evaluation.ts";
import { api, errorMessage } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { AiReadiness, useAiReady } from "../../components/TaskStatus.tsx";
import { EmptyState, formatDateTime, Link, Notice } from "../../components/ui.tsx";
import { jobPath } from "../../router.ts";
import { jobRevisions } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";
import { EvidenceChips, JobTaskStatus, useJobTask } from "./parts.tsx";

const VERDICT = { apply: "Apply", stretch: "Stretch", skip: "Skip" } as const;
const VERDICT_KIND = { apply: "success", stretch: "warning", skip: "danger" } as const;
const MATCH = { met: "Met", partial: "Partial", gap: "Gap" } as const;
const SOURCE = { "jd-wording": "Stated", "jd-structure": "Implied", estimate: "Estimate" } as const;
const AUTH = {
  compatible: "Compatible",
  "needs-sponsorship": "Needs sponsorship",
  incompatible: "Incompatible",
  unclear: "Unclear",
} as const;
const FIT = {
  fits: "Fits",
  partial: "Partly fits",
  "no-fit": "Does not fit",
  unclear: "Unclear",
} as const;
const LIVE = {
  live: "The posting looks open",
  closed: "The posting looks closed",
  unknown: "Not known whether it is still open",
} as const;
const REPOST = {
  no: "Not a repost",
  likely: "Likely a repost",
  unknown: "Repost unknown",
} as const;
const CAP_TEXT = {
  estimate: "Capped at 84: estimated requirements cannot carry a role into the top band.",
  "must-gap": "Capped at 69: a must-have requirement is a gap.",
} as const;

/** Starts tailoring from the chosen base; shared by the Evaluation and CV tabs. */
export function TailorAction(props: {
  detail: JobDetail;
  bases: { id: string; label: string }[];
  suggested: string | null;
  primary?: boolean;
}) {
  const { detail } = props;
  const id = detail.summary.id;
  const [base, setBase] = useState(
    detail.summary.base ?? props.suggested ?? props.bases[0]?.id ?? "",
  );
  const aiReady = useAiReady();
  const task = useJobTask(id);
  const running = task?.state === "running";
  const hasCv = detail.files.includes("cv.md");
  const state = detail.summary.state;
  const allowed = state === "evaluated" || state === "tailoring" || state === "ready";
  if (!allowed) return null;
  return (
    <div class="tailor-action">
      <select
        class="select"
        aria-label="Base CV to tailor from"
        value={base}
        onChange={(e) => setBase(e.currentTarget.value)}
      >
        {props.bases.map((b) => (
          <option key={b.id} value={b.id}>
            {b.label}
            {b.id === props.suggested ? " (suggested)" : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        class={`btn${props.primary ? " primary" : ""}`}
        disabled={running || aiReady === false || !base}
        onClick={async () => {
          try {
            await api.tailor(id, { base });
          } catch (e) {
            toast(errorMessage(e), "error");
          }
        }}
      >
        {hasCv ? "Tailor again" : "Tailor the CV"}
      </button>
    </div>
  );
}

function RequirementRow(props: { r: Requirement; view: EvaluationView }) {
  const { r, view } = props;
  return (
    <tr data-match={r.match}>
      <td>
        <div class="req-text">{r.text}</div>
        {r.quote ? <div class="req-quote">"{r.quote}"</div> : null}
        {r.note ? <div class="req-note">{r.note}</div> : null}
      </td>
      <td>
        <span class={`weight weight-${r.weight}`}>{r.weight}</span>
      </td>
      <td class="muted">{SOURCE[r.source]}</td>
      <td>
        <span class={`match match-${r.match}`}>
          <Icon name={r.match === "gap" ? "close" : "check"} size={12} />
          {MATCH[r.match]}
        </span>
      </td>
      <td>
        {r.evidence.length ? (
          <EvidenceChips ids={r.evidence} evidence={view.evidence} />
        ) : (
          <span class="muted">-</span>
        )}
      </td>
    </tr>
  );
}

export function EvaluationTab(props: { detail: JobDetail }) {
  const { detail } = props;
  const id = detail.summary.id;
  const [view, setView] = useState<EvaluationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = jobRevisions.value.get(id) ?? 0;
  const task = useJobTask(id);
  const aiReady = useAiReady();
  const running = task?.state === "running";

  useEffect(() => {
    let cancelled = false;
    api.evaluation(id).then(
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
  }, [id, revision]);

  const evaluate = async () => {
    try {
      await api.evaluate(id);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (error) return <Notice kind="danger">{error}</Notice>;
  if (!view) return <div class="empty compact muted">Loading the evaluation...</div>;
  const e = view.evaluation;
  const preApply = ["found", "evaluated", "tailoring", "ready", "approved"].includes(
    detail.summary.state,
  );

  if (!e) {
    return (
      <div class="job-tab">
        <JobTaskStatus task={task} />
        <AiReadiness ready={aiReady} />
        <section class="card">
          <EmptyState
            icon="insights"
            title="Not evaluated yet"
            actions={
              preApply ? (
                <button
                  type="button"
                  class="btn primary"
                  disabled={running || aiReady === false}
                  onClick={() => void evaluate()}
                >
                  Evaluate this job
                </button>
              ) : null
            }
          >
            Claude reads the posting next to your confirmed experience bank and preferences: the
            requirements with your evidence, a fit score computed from them, pay, work
            authorisation, legitimacy and a recommendation.
          </EmptyState>
        </section>
      </div>
    );
  }

  const score = view.score;
  return (
    <div class="job-tab">
      <JobTaskStatus task={task} />
      {view.stale.posting || view.stale.bank ? (
        <Notice kind="warning">
          {view.stale.posting && view.stale.bank
            ? "The posting and your experience bank changed"
            : view.stale.posting
              ? "The posting changed"
              : "Your experience bank changed"}{" "}
          since this evaluation was written. Evaluate again to bring it up to date.
        </Notice>
      ) : null}
      <section class="card eval-head">
        <div class="eval-score">
          <span class="score big" data-band={score?.band}>
            {score?.score ?? "--"}
          </span>
          <div>
            <div class="eval-band">
              {score ? `${score.band[0]?.toUpperCase()}${score.band.slice(1)} fit` : ""}
              <span class={`badge ${VERDICT_KIND[e.recommendation.verdict]}`}>
                {VERDICT[e.recommendation.verdict]}
              </span>
            </div>
            <p class="eval-reason">{e.recommendation.reason}</p>
            {score?.caps.map((cap) => (
              <p key={cap} class="muted eval-cap">
                {CAP_TEXT[cap]} Without the cap: {score.raw}.
              </p>
            ))}
            {score && score.score < view.threshold ? (
              <p class="eval-cap warning-text">
                Below your threshold of {view.threshold}: approving a CV for it will ask for a
                reason.
              </p>
            ) : null}
          </div>
        </div>
        <div class="eval-actions">
          <TailorAction
            detail={detail}
            bases={view.bases}
            suggested={e.level.base}
            primary={!detail.files.includes("cv.md")}
          />
          {detail.files.includes("cv.md") ? (
            <Link class="btn" href={jobPath(id, "cv")}>
              Open the CV review
            </Link>
          ) : null}
          {preApply ? (
            <button
              type="button"
              class="btn ghost"
              disabled={running || aiReady === false}
              onClick={() => void evaluate()}
            >
              Evaluate again
            </button>
          ) : null}
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Fit: requirements</h2>
        </header>
        <div class="card-body">
          <p class="secondary">{e.fit.rationale}</p>
        </div>
        <div class="table-wrap">
          <table class="req-table">
            <thead>
              <tr>
                <th>Requirement</th>
                <th>Weight</th>
                <th>Source</th>
                <th>Match</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {e.fit.requirements.map((r) => (
                <RequirementRow key={r.id} r={r} view={view} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div class="eval-grid">
        <section class="card">
          <header class="card-header">
            <h2>Role</h2>
          </header>
          <div class="card-body">
            <p>{e.summary.text}</p>
            {e.summary.hidden_signals.length ? (
              <ul class="plain-list">
                {e.summary.hidden_signals.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
        <section class="card">
          <header class="card-header">
            <h2>Level and base CV</h2>
          </header>
          <div class="card-body">
            <p>
              <strong>
                {view.bases.find((b) => b.id === e.level.base)?.label ?? e.level.base}
              </strong>
              . {e.level.rationale}
            </p>
          </div>
        </section>
        <section class="card">
          <header class="card-header">
            <h2>Compensation</h2>
          </header>
          <div class="card-body">
            <p>
              <span class="badge">{e.compensation.basis}</span>{" "}
              {e.compensation.range
                ? [
                    e.compensation.range.currency,
                    [e.compensation.range.min, e.compensation.range.max]
                      .filter((v) => v !== undefined)
                      .map((v) => v?.toLocaleString())
                      .join(" - "),
                    `per ${e.compensation.range.period}`,
                  ].join(" ")
                : null}
            </p>
            <p class="secondary">{e.compensation.note}</p>
          </div>
        </section>
        <section class="card">
          <header class="card-header">
            <h2>Work authorisation and location</h2>
          </header>
          <div class="card-body">
            <p>
              <span
                class={`badge ${e.work_authorization.status === "compatible" ? "success" : e.work_authorization.status === "incompatible" ? "danger" : "warning"}`}
              >
                {AUTH[e.work_authorization.status]}
              </span>{" "}
              <span class="badge">{FIT[e.work_authorization.location_fit]}</span>
            </p>
            <p class="secondary">{e.work_authorization.note}</p>
          </div>
        </section>
        <section class="card">
          <header class="card-header">
            <h2>Legitimacy</h2>
          </header>
          <div class="card-body">
            <p>
              <span
                class={`badge ${e.legitimacy.risk === "low" ? "success" : e.legitimacy.risk === "high" ? "danger" : "warning"}`}
              >
                {e.legitimacy.risk} risk
              </span>{" "}
              <span class="muted">
                {LIVE[e.legitimacy.live]}. {REPOST[e.legitimacy.repost]}.
              </span>
            </p>
            {e.legitimacy.ghost_signals.length ? (
              <ul class="plain-list">
                {e.legitimacy.ghost_signals.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      </div>
      <p class="muted eval-footer">
        Written {formatDateTime(e.created_at)} by {e.engine.model}. The score is computed from the
        requirement table: must 3, strong 2, nice 1; met counts fully, partial half.
      </p>
    </div>
  );
}
