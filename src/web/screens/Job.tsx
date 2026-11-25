import { useEffect, useRef, useState } from "preact/hooks";
import type { JobDetail } from "../../shared/schemas/api.ts";
import type { Note, Person, PersonRole, StatusEvent } from "../../shared/schemas/status.ts";
import { isClosed, PIPELINE, STATE_LABELS } from "../../shared/states.ts";
import { api, errorMessage } from "../api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { PostingText } from "../components/PostingText.tsx";
import {
  EmptyState,
  formatDate,
  formatDateTime,
  Kbd,
  Link,
  Notice,
  Score,
  StateBadge,
} from "../components/ui.tsx";
import { useHotkeys } from "../hotkeys.ts";
import { JOB_TABS, jobPath, navigate, type TabId } from "../router.ts";
import { openMove } from "../state/actions.ts";
import { jobRevisions, upsertJob } from "../state/store.ts";
import { toast } from "../state/toasts.ts";
import { ApplicationTab } from "./job/ApplicationTab.tsx";
import { CoverLetterTab } from "./job/CoverLetterTab.tsx";
import { CvTab } from "./job/CvTab.tsx";
import { EvaluationTab } from "./job/EvaluationTab.tsx";
import { DiagnosticList } from "./Settings.tsx";

const TAB_LABELS: Record<TabId, string> = {
  posting: "Posting",
  evaluation: "Evaluation",
  cv: "CV",
  "cover-letter": "Cover letter",
  application: "Application",
  interview: "Interview",
  timeline: "Timeline",
};

const LATER: Partial<Record<TabId, { milestone: string; text: string }>> = {
  interview: {
    milestone: "M6",
    text: "Likely questions, matching stories, the exact CV you sent and a place for debrief notes.",
  },
};

const RECOMMENDATION = { apply: "Apply", stretch: "Stretch", skip: "Skip" } as const;

/** Tabs that need the full width; the notes and contacts panel steps aside for them. */
const WIDE_TABS: readonly TabId[] = ["cv", "application", "cover-letter"];

const ROLE_LABELS: Record<PersonRole, string> = {
  recruiter: "Recruiter",
  "hiring-manager": "Hiring manager",
  interviewer: "Interviewer",
  referral: "Referral",
  other: "Other",
};

const WORKPLACE: Record<string, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On site",
};

function Stepper(props: { detail: JobDetail }) {
  const { state } = props.detail.summary;
  const reached = new Set(props.detail.status?.history.map((e) => e.to) ?? []);
  const currentIndex = (PIPELINE as readonly string[]).indexOf(state);
  return (
    <ol class="stepper" aria-label="Pipeline progress">
      {PIPELINE.map((step, i) => (
        <li
          key={step}
          data-state={step}
          aria-current={step === state ? "step" : undefined}
          data-done={
            (currentIndex >= 0 ? i < currentIndex : reached.has(step)) ? "true" : undefined
          }
        >
          {STATE_LABELS[step]}
        </li>
      ))}
      {isClosed(state) ? (
        <li class="stepper-closed">
          <StateBadge state={state} />
        </li>
      ) : null}
    </ol>
  );
}

function PostingTab(props: { detail: JobDetail; onChange: (d: JobDetail) => void }) {
  const { detail } = props;
  const front = detail.posting?.frontmatter;
  if (!detail.posting) {
    return (
      <EmptyState icon="alert" title="No posting snapshot">
        posting.md is missing.
      </EmptyState>
    );
  }
  return (
    <article class="posting">
      <div class="posting-meta">
        {front ? (
          <span>
            {front.source === "manual-text" ? "Pasted" : "Fetched"}{" "}
            {formatDateTime(front.fetched_at)}
          </span>
        ) : null}
        {front?.posted_at ? <span>Posted {formatDate(front.posted_at)}</span> : null}
        {front?.valid_through ? <span>Open until {formatDate(front.valid_through)}</span> : null}
        {front?.url ? (
          <a href={front.url} target="_blank" rel="noreferrer noopener">
            Open original <Icon name="external" size={12} />
          </a>
        ) : null}
        {detail.hasRawHtml ? (
          <a href={api.rawPostingUrl(detail.summary.id)} target="_blank" rel="noreferrer noopener">
            Raw snapshot <Icon name="external" size={12} />
          </a>
        ) : null}
      </div>
      {detail.posting.body.trim() ? (
        <PostingText text={detail.posting.body} />
      ) : (
        <PasteText detail={detail} onChange={props.onChange} />
      )}
    </article>
  );
}

/** For postings that arrived without their text (a LinkedIn alert when LinkedIn refused the page). */
function PasteText(props: { detail: JobDetail; onChange: (d: JobDetail) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const url = props.detail.posting?.frontmatter?.url;
  return (
    <div class="paste-posting">
      <Notice>
        This posting came without its text
        {url ? (
          <>
            {" "}
            (LinkedIn usually hides it from signed-out visitors). Open{" "}
            <a href={url} target="_blank" rel="noreferrer noopener">
              the posting
            </a>
            , copy its text and paste it here.
          </>
        ) : (
          ". Paste it here."
        )}{" "}
        Evaluating needs it.
      </Notice>
      <textarea
        class="textarea"
        rows={10}
        aria-label="Posting text"
        placeholder="The full posting: role, responsibilities, requirements..."
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <div>
        <button
          type="button"
          class="btn primary"
          disabled={busy || text.trim().length < 20}
          onClick={async () => {
            setBusy(true);
            try {
              props.onChange(await api.setPostingText(props.detail.summary.id, text));
            } catch (e) {
              toast(errorMessage(e), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          Save the posting text
        </button>
      </div>
    </div>
  );
}

type TimelineItem =
  | { kind: "event"; at: string; event: StatusEvent }
  | { kind: "note"; at: string; note: Note };

function TimelineTab(props: { detail: JobDetail }) {
  const status = props.detail.status;
  if (!status)
    return (
      <EmptyState icon="alert" title="No status history">
        status.yaml is missing or invalid.
      </EmptyState>
    );
  const items: TimelineItem[] = [
    ...status.history.map((event) => ({ kind: "event" as const, at: event.at, event })),
    ...status.notes.map((note) => ({ kind: "note" as const, at: note.at, note })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return (
    <ol class="timeline">
      {items.map((item, i) =>
        item.kind === "event" ? (
          <li key={`e${i}`} data-state={item.event.to}>
            <span class="state-dot" />
            <div>
              <div>
                {item.event.from === null ? (
                  <>Added as {STATE_LABELS[item.event.to]}</>
                ) : (
                  <>
                    {STATE_LABELS[item.event.from]} <Icon name="chevronRight" size={12} />{" "}
                    <strong>{STATE_LABELS[item.event.to]}</strong>
                  </>
                )}
                {item.event.by !== "user" ? <span class="muted"> by {item.event.by}</span> : null}
              </div>
              {item.event.reason ? <div class="secondary">{item.event.reason}</div> : null}
              <time class="muted">{formatDateTime(item.event.at)}</time>
            </div>
          </li>
        ) : (
          <li key={`n${i}`} class="timeline-note">
            <Icon name="note" size={14} />
            <div>
              <div class="note-text">{item.note.text}</div>
              <time class="muted">{formatDateTime(item.note.at)}</time>
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

function Notes(props: {
  detail: JobDetail;
  onChange: (d: JobDetail) => void;
  inputRef: { current: HTMLTextAreaElement | null };
}) {
  const { detail } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = detail.status?.notes ?? [];

  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      props.onChange(await api.addNote(detail.summary.id, { text }));
      setText("");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="side-section">
      <h3>Notes</h3>
      {notes.length === 0 ? <p class="muted">No notes yet.</p> : null}
      <ul class="side-list">
        {notes.map((note, i) => (
          <li key={note.at + i}>
            <div class="note-text">{note.text}</div>
            <div class="side-list-meta">
              <time class="muted">{formatDate(note.at)}</time>
              <button
                type="button"
                class="btn ghost icon small"
                aria-label="Delete note"
                onClick={async () => {
                  try {
                    props.onChange(await api.deleteNote(detail.summary.id, i, note.at));
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  }
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <textarea
        ref={props.inputRef}
        class="textarea"
        style={{ minHeight: "60px" }}
        placeholder="Add a note"
        aria-label="New note"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
      />
      {text.trim() ? (
        <button type="button" class="btn small" disabled={busy} onClick={() => void add()}>
          Add note <Kbd keys="mod+enter" />
        </button>
      ) : null}
    </section>
  );
}

function Contacts(props: { detail: JobDetail; onChange: (d: JobDetail) => void }) {
  const { detail } = props;
  const contacts = detail.status?.contacts ?? [];
  const [adding, setAdding] = useState(false);
  const [person, setPerson] = useState<Person>({ name: "", role: "recruiter" });

  const save = async () => {
    if (!person.name.trim()) return;
    try {
      const body: Person = {
        name: person.name.trim(),
        role: person.role,
        ...(person.email?.trim() ? { email: person.email.trim() } : {}),
      };
      props.onChange(await api.addContact(detail.summary.id, body));
      setPerson({ name: "", role: "recruiter" });
      setAdding(false);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <section class="side-section">
      <h3>
        Contacts
        {!adding ? (
          <button type="button" class="btn ghost small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Add
          </button>
        ) : null}
      </h3>
      {contacts.length === 0 && !adding ? <p class="muted">No contacts yet.</p> : null}
      <ul class="side-list">
        {contacts.map((c, i) => (
          <li key={c.name + i}>
            <div>
              <strong>{c.name}</strong> <span class="muted">{ROLE_LABELS[c.role]}</span>
            </div>
            <div class="side-list-meta">
              {c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span />}
              <button
                type="button"
                class="btn ghost icon small"
                aria-label={`Remove ${c.name}`}
                onClick={async () => {
                  try {
                    props.onChange(await api.deleteContact(detail.summary.id, i, c.name));
                  } catch (e) {
                    toast(errorMessage(e), "error");
                  }
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          class="contact-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            class="input"
            placeholder="Name"
            aria-label="Contact name"
            value={person.name}
            onInput={(e) => setPerson({ ...person, name: e.currentTarget.value })}
          />
          <select
            class="select"
            aria-label="Contact role"
            value={person.role}
            onChange={(e) => setPerson({ ...person, role: e.currentTarget.value as PersonRole })}
          >
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <input
            class="input"
            type="email"
            placeholder="Email (optional)"
            aria-label="Contact email"
            value={person.email ?? ""}
            onInput={(e) => setPerson({ ...person, email: e.currentTarget.value })}
          />
          <div style={{ display: "flex", gap: "6px" }}>
            <button type="submit" class="btn small primary" disabled={!person.name.trim()}>
              Save
            </button>
            <button type="button" class="btn small" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function Files(props: { detail: JobDetail }) {
  const { usage } = props.detail;
  return (
    <section class="side-section">
      <h3>
        Files
        <button
          type="button"
          class="btn ghost small"
          onClick={() =>
            api.openFolder(props.detail.summary.id).catch((e) => toast(errorMessage(e), "error"))
          }
        >
          <Icon name="folder" size={12} /> Open folder
        </button>
      </h3>
      <ul class="file-list">
        {props.detail.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
      </ul>
      {usage.tasks > 0 ? (
        <p class="muted small-print">
          AI work on this job: {usage.tasks} {usage.tasks === 1 ? "task" : "tasks"},{" "}
          {((usage.inputTokens + usage.outputTokens) / 1000).toFixed(1)}k tokens
          {usage.costUsd !== null ? `, about $${usage.costUsd.toFixed(2)}` : ""}.
        </p>
      ) : null}
    </section>
  );
}

export function JobScreen(props: ScreenProps & { id: string; tab: TabId }) {
  const { id, tab } = props;
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Focus synchronously from the hotkey, so fast typing right after N lands in the field.
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const revision = jobRevisions.value.get(id) ?? 0;

  useEffect(() => {
    let cancelled = false;
    api
      .job(id)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, revision]);

  useEffect(() => {
    if (detail) document.title = `${detail.summary.company}: ${detail.summary.title} - Hirehound`;
  }, [detail?.summary.company, detail?.summary.title]);

  const onChange = (next: JobDetail) => {
    setDetail(next);
    upsertJob(next.summary);
  };

  useHotkeys([
    ...JOB_TABS.map((t, i) => ({
      keys: String(i + 1),
      group: "Job",
      description: TAB_LABELS[t],
      hidden: i > 0,
      run: () => navigate(jobPath(id, t), { replace: true }),
    })),
    {
      keys: "m",
      group: "Job",
      description: "Move to...",
      run: () => {
        if (detail) openMove([detail.summary]);
      },
    },
    {
      keys: "n",
      group: "Job",
      description: "Add a note",
      run: () => noteInput.current?.focus(),
    },
    {
      keys: "o",
      group: "Job",
      description: "Open original posting",
      run: () => {
        const url = detail?.posting?.frontmatter?.url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    {
      keys: "escape",
      group: "Job",
      description: "Back to pipeline",
      run: () => navigate("/pipeline"),
    },
  ]);

  if (error) {
    return (
      <>
        {props.frame(<Link href="/pipeline">Pipeline</Link>)}
        <div class="content">
          <EmptyState
            icon="alert"
            title="Job not found"
            actions={
              <button type="button" class="btn" onClick={() => navigate("/pipeline")}>
                Back to pipeline
              </button>
            }
          >
            {error}
          </EmptyState>
        </div>
      </>
    );
  }
  if (!detail || detail.summary.id !== id) {
    return (
      <>
        {props.frame(<Link href="/pipeline">Pipeline</Link>)}
        <div class="content">
          <div class="empty compact muted">Loading job...</div>
        </div>
      </>
    );
  }

  const { summary } = detail;
  const front = detail.posting?.frontmatter;
  const later = LATER[tab];

  return (
    <>
      {props.frame(
        <>
          <Link href="/pipeline">Pipeline</Link>
          <Icon name="chevronRight" size={12} />
          <span class="truncate">{summary.company}</span>
        </>,
        <button type="button" class="btn" onClick={() => openMove([summary])}>
          Move to... <kbd>M</kbd>
        </button>,
      )}
      <div class="content job">
        <header class="job-header">
          <div class="job-heading">
            <Score score={summary.score} band={summary.band} />
            <div>
              <h1>
                {summary.title} <span class="muted">at</span> {summary.company}
              </h1>
              <div class="job-facts">
                <StateBadge state={summary.state} external={summary.appliedExternally} />
                {summary.recommendation ? (
                  <span
                    class={`badge ${summary.recommendation === "apply" ? "success" : summary.recommendation === "skip" ? "danger" : "warning"}`}
                    title="The evaluation's recommendation"
                  >
                    {RECOMMENDATION[summary.recommendation]}
                  </span>
                ) : null}
                {summary.listed === false ? (
                  <span
                    class="badge warning"
                    title={
                      detail.status?.listing
                        ? `Since ${formatDateTime(detail.status.listing.since)}`
                        : undefined
                    }
                  >
                    No longer listed
                  </span>
                ) : null}
                {summary.repostOf ? (
                  <Link
                    class="badge warning"
                    href={jobPath(summary.repostOf)}
                    title="An earlier job for the same company and role"
                  >
                    Repost
                  </Link>
                ) : null}
                {summary.location ? <span>{summary.location}</span> : null}
                {WORKPLACE[summary.workplace] ? <span>{WORKPLACE[summary.workplace]}</span> : null}
                {front?.salary?.raw ? <span>{front.salary.raw}</span> : null}
                {summary.base ? <span>Base: {summary.base}</span> : null}
                <span class="muted">Added {formatDate(summary.addedAt)}</span>
              </div>
            </div>
          </div>
          <Stepper detail={detail} />
        </header>
        <nav class="tabs" aria-label="Job sections">
          {JOB_TABS.map((t, i) => (
            <Link
              key={t}
              href={jobPath(id, t)}
              class="tab"
              aria-current={t === tab ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(jobPath(id, t), { replace: true });
              }}
            >
              {TAB_LABELS[t]} <kbd>{i + 1}</kbd>
            </Link>
          ))}
        </nav>
        <div class={`job-body${WIDE_TABS.includes(tab) ? " wide" : ""}`}>
          <div class="job-main">
            {detail.diagnostics.length ? (
              <Notice kind={summary.errors ? "danger" : "warning"}>
                <strong>Some files in this job have problems.</strong>
                <DiagnosticList items={detail.diagnostics} />
              </Notice>
            ) : null}
            {tab === "posting" ? <PostingTab detail={detail} onChange={onChange} /> : null}
            {tab === "evaluation" ? <EvaluationTab detail={detail} /> : null}
            {tab === "cv" ? <CvTab detail={detail} onChange={onChange} /> : null}
            {tab === "cover-letter" ? <CoverLetterTab detail={detail} onChange={onChange} /> : null}
            {tab === "application" ? <ApplicationTab detail={detail} onChange={onChange} /> : null}
            {tab === "timeline" ? <TimelineTab detail={detail} /> : null}
            {later ? (
              <EmptyState icon="info" title={`${TAB_LABELS[tab]} arrives in ${later.milestone}`}>
                {later.text}
              </EmptyState>
            ) : null}
          </div>
          {WIDE_TABS.includes(tab) ? null : (
            <aside class="job-side">
              <Notes detail={detail} onChange={onChange} inputRef={noteInput} />
              <Contacts detail={detail} onChange={onChange} />
              <Files detail={detail} />
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
