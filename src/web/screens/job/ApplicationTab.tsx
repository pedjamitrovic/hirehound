import { useEffect, useState } from "preact/hooks";
import type {
  ApplicationView,
  AssistState,
  FieldOutcome,
  JobDetail,
} from "../../../shared/schemas/api.ts";
import { api, errorMessage } from "../../api.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { AiReadiness, useAiReady } from "../../components/TaskStatus.tsx";
import { EmptyState, formatDateTime, Kbd, Link, Notice } from "../../components/ui.tsx";
import { jobPath } from "../../router.ts";
import { jobRevisions, upsertJob } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";
import { JobTaskStatus, plural, useJobTask } from "./parts.tsx";

const STATUS_LABEL: Record<FieldOutcome["status"], string> = {
  filled: "Filled",
  uploaded: "Attached",
  ask: "Your answer",
  kept: "Kept",
  skipped: "Left empty",
  failed: "Failed",
};

const SOURCE_LABEL = {
  profile: "contact details",
  library: "saved answer",
  job: "posting",
  you: "you",
  document: "file",
} as const;

function useApplication(id: string) {
  const [view, setView] = useState<ApplicationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const revision = jobRevisions.value.get(id) ?? 0;
  const task = useJobTask(id);
  useEffect(() => {
    let cancelled = false;
    api.application(id).then(
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
  }, [id, revision, nonce, task?.state]);
  return {
    view,
    error,
    reload: () => setNonce((n) => n + 1),
    setAssist: (assist: AssistState) => setView((v) => (v ? { ...v, assist } : v)),
  };
}

function CopyRow(props: { label: string; value: string; note?: string }) {
  return (
    <li class="copy-row">
      <div>
        <div class="copy-label">{props.label}</div>
        <div class="copy-value">{props.value}</div>
        {props.note ? <div class="muted small-print">{props.note}</div> : null}
      </div>
      <button
        type="button"
        class="btn small ghost"
        aria-label={`Copy ${props.label}`}
        onClick={() =>
          navigator.clipboard.writeText(props.value).then(
            () => toast(`Copied: ${props.label}`, "success"),
            () => toast("Copying failed; select the text instead.", "error"),
          )
        }
      >
        Copy
      </button>
    </li>
  );
}

function SubmittedDialog(props: {
  id: string;
  view: ApplicationView;
  method: "manual" | "assisted";
  onClose: () => void;
  onDone: (detail: JobDetail) => void;
}) {
  const { view } = props;
  const [text, setText] = useState("");
  const [url, setUrl] = useState(view.assist.url ?? view.url ?? "");
  const [cover, setCover] = useState(Boolean(view.coverLetter));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const detail = await api.applied(props.id, {
        method: props.method,
        ...(url.trim() ? { url: url.trim() } : {}),
        ...(text.trim() ? { confirmationText: text.trim() } : {}),
        coverLetter: cover,
      });
      props.onDone(detail);
      props.onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="I submitted the application"
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" class="btn primary" disabled={busy} onClick={() => void submit()}>
            Record it <Kbd keys="mod+enter" />
          </button>
        </>
      }
    >
      <p>
        Only record this after you pressed Submit yourself. Hirehound keeps the exact PDF you
        approved, the answers it filled in
        {props.method === "assisted" ? " and a screenshot of the page now open in the browser" : ""}
        .
      </p>
      <label class="field">
        <span>Where you applied</span>
        <input class="input" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Confirmation (optional)</span>
        <textarea
          class="textarea"
          rows={4}
          placeholder="Paste the confirmation message or email"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      {view.coverLetter ? (
        <label class="toggle">
          <input type="checkbox" checked={cover} onChange={() => setCover(!cover)} />I also sent the
          approved cover letter
        </label>
      ) : null}
    </Dialog>
  );
}

function AskRow(props: {
  field: FieldOutcome;
  value: string;
  save: boolean;
  onChange: (value: string, save: boolean) => void;
}) {
  const { field } = props;
  const choice = field.type === "select" || field.type === "radio";
  return (
    <div class="ask-row">
      <div class="ask-question">
        {field.label || field.id}
        {field.required ? <span class="danger-text"> *</span> : null}
        {field.note ? <div class="muted small-print">{field.note}</div> : null}
      </div>
      {choice ? (
        <select
          class="select"
          aria-label={field.label}
          value={props.value}
          onChange={(e) => props.onChange(e.currentTarget.value, props.save)}
        >
          <option value="">Choose...</option>
          {field.options
            // A select's empty-value entry is its placeholder ("Select..."), not an answer.
            .filter((o) => field.type === "radio" || o.value !== "")
            .map((o) => (
              <option key={o.label} value={o.label}>
                {o.label}
              </option>
            ))}
        </select>
      ) : field.type === "checkbox" ? (
        <label class="toggle">
          <input
            type="checkbox"
            checked={props.value === "true"}
            onChange={(e) => props.onChange(e.currentTarget.checked ? "true" : "false", false)}
          />
          Tick it
        </label>
      ) : field.type === "file" ? (
        <span class="muted">Attach this one in the browser window.</span>
      ) : (
        <textarea
          class="textarea"
          rows={field.type === "textarea" ? 3 : 1}
          aria-label={field.label}
          value={props.value}
          placeholder={field.suggestion ?? ""}
          onInput={(e) => props.onChange(e.currentTarget.value, props.save)}
        />
      )}
      {field.type !== "checkbox" && field.type !== "file" ? (
        <label class="toggle small-print">
          <input
            type="checkbox"
            checked={props.save}
            onChange={() => props.onChange(props.value, !props.save)}
          />
          Save to my answers
        </label>
      ) : null}
    </div>
  );
}

function Assisted(props: {
  id: string;
  view: ApplicationView;
  onState: (s: AssistState) => void;
  onSubmitted: () => void;
}) {
  const { id, view } = props;
  const assist = view.assist;
  const [url, setUrl] = useState(assist.url ?? view.url ?? "");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, { value: string; save: boolean }>>({});
  const task = useJobTask(id);
  const running = task?.state === "running";
  const aiReady = useAiReady();
  const asks = assist.fields.filter((f) => f.status === "ask" || f.status === "failed");
  const done = assist.fields.filter((f) => f.status !== "ask" && f.status !== "failed");

  useEffect(() => {
    // Suggestions start as the answer; you change what you need.
    const next: Record<string, { value: string; save: boolean }> = {};
    for (const f of asks) next[f.id] = { value: f.suggestion ?? "", save: false };
    setAnswers(next);
  }, [assist.filledAt]);

  const act = async (work: () => Promise<AssistState | unknown>) => {
    setBusy(true);
    try {
      const result = await work();
      if (result && typeof result === "object" && "fields" in result)
        props.onState(result as AssistState);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="assist">
      <Notice>
        Hirehound opens the application in its own browser window, reads the form and fills what it
        can from your profile and saved answers. It never presses Submit and never solves CAPTCHAs:
        you check every field and submit it yourself.
      </Notice>
      <AiReadiness ready={aiReady} />
      <div class="assist-open">
        <input
          class="input"
          aria-label="Application page"
          value={url}
          placeholder="https://..."
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        <button
          type="button"
          class={`btn${assist.open ? "" : " primary"}`}
          disabled={busy || !/^https?:\/\//.test(url.trim())}
          onClick={() => void act(() => api.assistOpen(id, url.trim()))}
        >
          {assist.open ? "Open again" : "Open in the browser"}
        </button>
        {assist.open ? (
          <button
            type="button"
            class="btn ghost"
            disabled={busy}
            onClick={() => void act(() => api.assistClose(id))}
          >
            Close the tab
          </button>
        ) : null}
      </div>
      {assist.open ? (
        <div class="assist-page">
          <Icon name="external" size={13} />
          <span class="truncate">{assist.title || assist.url}</span>
        </div>
      ) : null}
      {assist.captcha ? (
        <Notice kind="warning">
          The page shows a CAPTCHA or a bot check. Solve it yourself in the browser window.
        </Notice>
      ) : null}
      <JobTaskStatus task={task} />
      {assist.open ? (
        <div class="assist-actions">
          <button
            type="button"
            class="btn primary"
            disabled={running || aiReady === false}
            onClick={() => api.assistFill(id).catch((e) => toast(errorMessage(e), "error"))}
          >
            Fill this page
          </button>
          <span class="muted small-print">
            Multi-page form? Go to the next page in the browser, then fill again.
          </span>
        </div>
      ) : null}

      {asks.length ? (
        <section class="card">
          <header class="card-header">
            <h2>Needs your answer ({asks.length})</h2>
          </header>
          <div class="card-body ask-list">
            {asks.map((f) => (
              <AskRow
                key={f.id}
                field={f}
                value={answers[f.id]?.value ?? ""}
                save={answers[f.id]?.save ?? false}
                onChange={(value, save) => setAnswers({ ...answers, [f.id]: { value, save } })}
              />
            ))}
            <div>
              <button
                type="button"
                class="btn primary"
                disabled={busy || !Object.values(answers).some((a) => a.value.trim())}
                onClick={() =>
                  void act(() =>
                    api.assistAnswer(id, {
                      answers: Object.entries(answers)
                        .filter(([, a]) => a.value.trim())
                        .map(([fieldId, a]) => ({ fieldId, value: a.value, save: a.save })),
                    }),
                  )
                }
              >
                Fill these in
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {done.length ? (
        <section class="card">
          <header class="card-header">
            <h2>On the page ({done.length})</h2>
            {assist.filledAt ? (
              <span class="actions muted small-print">
                Filled {formatDateTime(assist.filledAt)}
              </span>
            ) : null}
          </header>
          <table class="req-table fill-table">
            <tbody>
              {done.map((f) => (
                <tr key={f.id} data-status={f.status}>
                  <td>{f.label || f.id}</td>
                  <td>
                    <span
                      class={`badge${f.status === "filled" || f.status === "uploaded" ? " success" : ""}`}
                    >
                      {STATUS_LABEL[f.status]}
                    </span>
                  </td>
                  <td class="fill-value">{f.filled ?? f.value}</td>
                  <td class="muted small-print">{f.source ? SOURCE_LABEL[f.source] : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {assist.open ? (
        <div class="assist-actions">
          <button type="button" class="btn" onClick={props.onSubmitted}>
            I submitted it
          </button>
          <span class="muted small-print">After you pressed Submit in the browser window.</span>
        </div>
      ) : null}
    </div>
  );
}

function Record(props: { id: string; view: ApplicationView }) {
  const record = props.view.record;
  if (!record) {
    return (
      <Notice>
        Applied{props.view.state === "applied" ? "" : ` (${props.view.state})`}. There is no
        application.md for it, for example when it was recorded as applied outside Hirehound.
      </Notice>
    );
  }
  return (
    <div class="job-tab">
      <section class="card">
        <header class="card-header">
          <h2>Applied {formatDateTime(record.applied_at)}</h2>
          <span class="actions badge success">
            {record.method === "assisted" ? "Assisted" : "Manual"}
          </span>
        </header>
        <div class="card-body">
          <dl class="kv">
            {record.url ? (
              <>
                <dt>Where</dt>
                <dd>
                  <a href={record.url} target="_blank" rel="noopener noreferrer">
                    {record.url}
                  </a>
                </dd>
              </>
            ) : null}
            <dt>CV sent</dt>
            <dd>
              <a href={api.cvPdfUrl(props.id)} target="_blank" rel="noopener noreferrer">
                {record.cv.file}
              </a>{" "}
              <span class="muted">SHA-256 {record.cv.sha256.slice(0, 12)}</span>
            </dd>
            {record.cover_letter ? (
              <>
                <dt>Cover letter</dt>
                <dd>
                  {record.cover_letter.file}{" "}
                  <span class="muted">SHA-256 {record.cover_letter.sha256.slice(0, 12)}</span>
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </section>
      {record.answers.length ? (
        <section class="card">
          <header class="card-header">
            <h2>Answers ({record.answers.length})</h2>
          </header>
          <table class="req-table fill-table">
            <tbody>
              {record.answers.map((a) => (
                <tr key={a.question}>
                  <td>{a.question}</td>
                  <td class="fill-value">{a.answer}</td>
                  <td class="muted small-print">{SOURCE_LABEL[a.source]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {record.confirmation ? (
        <section class="card">
          <header class="card-header">
            <h2>Confirmation</h2>
          </header>
          <div class="card-body">
            {record.confirmation.title ? (
              <p>
                <strong>{record.confirmation.title}</strong>
              </p>
            ) : null}
            {record.confirmation.text ? (
              <pre class="posting-preview">{record.confirmation.text}</pre>
            ) : null}
            {record.confirmation.screenshot ? (
              <img
                class="confirmation-shot"
                src={api.confirmationUrl(props.id)}
                alt="The page after you submitted"
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function ApplicationTab(props: {
  detail: JobDetail;
  onChange: (detail: JobDetail) => void;
}) {
  const { detail } = props;
  const id = detail.summary.id;
  const { view, error, setAssist } = useApplication(id);
  const [mode, setMode] = useState<"manual" | "assisted" | null>(null);
  const [submitting, setSubmitting] = useState<"manual" | "assisted" | null>(null);

  if (error) return <Notice kind="danger">{error}</Notice>;
  if (!view) return <div class="empty compact muted">Loading...</div>;
  if (view.record || view.state === "applied" || detail.status?.application) {
    return <Record id={id} view={view} />;
  }
  if (view.state !== "approved") {
    return (
      <section class="card">
        <EmptyState
          icon="check"
          title="Approve the CV first"
          actions={
            <Link class="btn primary" href={jobPath(id, "cv")}>
              Open the CV review
            </Link>
          }
        >
          {view.blockers[0]} Applying always uses the exact PDF you approved.
        </EmptyState>
      </section>
    );
  }
  const current = mode ?? view.mode;
  const library = view.answers.filter((a) => !a.sensitive);
  return (
    <div class="apply">
      <div class="apply-main">
        {view.blockers.length ? <Notice kind="danger">{view.blockers[0]}</Notice> : null}
        <div class="segmented" role="tablist" aria-label="How to apply">
          {(["manual", "assisted"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={current === m}
              onClick={() => setMode(m)}
            >
              {m === "manual" ? "Apply yourself" : "Assisted"}
              {view.mode === m ? <span class="muted"> (your default)</span> : null}
            </button>
          ))}
        </div>
        {current === "manual" ? (
          <ol class="checklist">
            <li>
              <strong>Open the application page.</strong>
              {view.url ? (
                <a class="btn small" href={view.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" size={12} /> Open the posting
                </a>
              ) : (
                <span class="muted">
                  {" "}
                  The posting has no link; find the application form yourself.
                </span>
              )}
            </li>
            <li>
              <strong>Attach your CV.</strong> It is the exact PDF you approved.
              <a class="btn small" href={api.cvDownloadUrl(id)} download={view.cv.fileName}>
                Download {view.cv.fileName}
              </a>
            </li>
            <li>
              <strong>Cover letter.</strong>{" "}
              {view.coverLetter ? (
                <>
                  If the form asks for one, attach the approved letter.
                  <a
                    class="btn small"
                    href={api.coverLetterPdfUrl(id, true)}
                    download={view.coverLetter.fileName}
                  >
                    Download {view.coverLetter.fileName}
                  </a>
                </>
              ) : (
                <span class="muted">
                  None approved. If the form asks for one, write it in the{" "}
                  <Link href={jobPath(id, "cover-letter")}>Cover letter</Link> tab.
                </span>
              )}
            </li>
            <li>
              <strong>Fill in the form</strong> with the copy-ready answers on the right.
            </li>
            <li>
              <strong>Press Submit yourself</strong>, then record it here.
              <button
                type="button"
                class="btn primary small"
                disabled={view.blockers.length > 0}
                onClick={() => setSubmitting("manual")}
              >
                I submitted it
              </button>
            </li>
          </ol>
        ) : (
          <Assisted
            id={id}
            view={view}
            onState={setAssist}
            onSubmitted={() => setSubmitting("assisted")}
          />
        )}
      </div>
      <aside class="apply-side" aria-label="Copy-ready answers">
        <section class="card">
          <header class="card-header">
            <h2>Contact details</h2>
          </header>
          <ul class="copy-list">
            {view.contact.map((c) => (
              <CopyRow key={c.label} label={c.label} value={c.value} />
            ))}
          </ul>
        </section>
        <section class="card">
          <header class="card-header">
            <h2>Saved answers ({library.length})</h2>
            <Link class="actions" href="/profile/answers">
              Edit
            </Link>
          </header>
          {library.length ? (
            <ul class="copy-list">
              {library.map((a) => (
                <CopyRow key={a.id} label={a.question} value={a.answer} />
              ))}
            </ul>
          ) : (
            <div class="card-body muted">
              No saved answers yet. Answers you type during assisted apply can be saved here.
            </div>
          )}
          {view.answers.length > library.length ? (
            <div class="card-body muted small-print">
              {plural(view.answers.length - library.length, "sensitive answer")} hidden; they are
              never filled in without asking.
            </div>
          ) : null}
        </section>
      </aside>
      {submitting ? (
        <SubmittedDialog
          id={id}
          view={view}
          method={submitting}
          onClose={() => setSubmitting(null)}
          onDone={(next) => {
            props.onChange(next);
            upsertJob(next.summary);
            toast("Recorded as applied. Good luck!", "success");
          }}
        />
      ) : null}
    </div>
  );
}
