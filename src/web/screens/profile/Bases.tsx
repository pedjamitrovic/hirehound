import { useEffect, useRef, useState } from "preact/hooks";
import type { BaseDetail, BaseSummary } from "../../../shared/schemas/api.ts";
import { ApiError, api, type BaseSpecInput, errorMessage } from "../../api.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import {
  AiReadiness,
  TaskStatus,
  useAiReady,
  useTask,
  useTaskOutcome,
} from "../../components/TaskStatus.tsx";
import { EmptyState, formatDate, Kbd, Link, Notice } from "../../components/ui.tsx";
import { useHotkeys } from "../../hotkeys.ts";
import { navigate } from "../../router.ts";
import { profileRevision, workspace } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";

const basePath = (id: string) => `/profile/bases/${encodeURIComponent(id)}`;

const splitList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Asks what the base CV is for, then drafts it from confirmed bank entries. */
export function NewBaseDialog(props: {
  onClose: () => void;
  onCreated: (id: string) => void;
  initial?: Partial<BaseSpecInput>;
}) {
  const [spec, setSpec] = useState({
    label: props.initial?.label ?? "",
    track: props.initial?.track ?? ("ic" as BaseSpecInput["track"]),
    titles: (props.initial?.target_titles ?? []).join(", "),
    emphasis: (props.initial?.emphasis ?? []).join(", "),
  });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const task = useTask(taskId);
  const aiReady = useAiReady();
  useTaskOutcome(task, {
    onDone: (t) => {
      const result = t.result as { id: string; notes: string } | undefined;
      if (result?.notes) toast(result.notes, "info");
      if (result?.id) props.onCreated(result.id);
    },
  });

  const start = async () => {
    if (!spec.label.trim() || aiReady === false) return;
    setError(null);
    try {
      const started = await api.draftBase({
        label: spec.label.trim(),
        track: spec.track,
        target_titles: splitList(spec.titles),
        emphasis: splitList(spec.emphasis),
      });
      setTaskId(started.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const running = task?.state === "running";
  return (
    <Dialog
      title="New base CV"
      onClose={props.onClose}
      onSubmit={() => void start()}
      footer={
        <>
          <span class="muted">Written only from confirmed experience bank entries.</span>
          <span class="spacer" />
          <button type="button" class="btn" onClick={props.onClose}>
            {running ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            class="btn primary"
            disabled={!spec.label.trim() || running || aiReady === false}
            onClick={() => void start()}
          >
            Write it <Kbd keys="mod+enter" />
          </button>
        </>
      }
    >
      <div class="form-grid">
        <div class="field">
          <label for="base-label">Name</label>
          <input
            id="base-label"
            class="input"
            placeholder="Engineering Manager"
            value={spec.label}
            onInput={(e) => setSpec({ ...spec, label: e.currentTarget.value })}
          />
        </div>
        <div class="field">
          <span class="label">Track</span>
          <fieldset class="btn-group">
            <legend class="visually-hidden">Track</legend>
            <button
              type="button"
              class="btn"
              aria-pressed={spec.track === "management"}
              onClick={() => setSpec({ ...spec, track: "management" })}
            >
              Management
            </button>
            <button
              type="button"
              class="btn"
              aria-pressed={spec.track === "ic"}
              onClick={() => setSpec({ ...spec, track: "ic" })}
            >
              Individual contributor
            </button>
          </fieldset>
        </div>
        <div class="field span-2">
          <label for="base-titles">Target titles</label>
          <input
            id="base-titles"
            class="input"
            placeholder="Engineering Manager, Senior Engineering Manager"
            value={spec.titles}
            onInput={(e) => setSpec({ ...spec, titles: e.currentTarget.value })}
          />
        </div>
        <div class="field span-2">
          <label for="base-emphasis">Emphasis</label>
          <input
            id="base-emphasis"
            class="input"
            placeholder="people leadership, platform, delivery"
            value={spec.emphasis}
            onInput={(e) => setSpec({ ...spec, emphasis: e.currentTarget.value })}
          />
          <span class="hint">What this CV should lead with. Comma-separated.</span>
        </div>
      </div>
      <AiReadiness ready={aiReady} />
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {task ? <TaskStatus task={task} /> : null}
    </Dialog>
  );
}

export function BaseList() {
  const [bases, setBases] = useState<BaseSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const revision = profileRevision.value;

  useEffect(() => {
    api
      .bases()
      .then(setBases)
      .catch((e) => toast(errorMessage(e), "error"));
  }, [revision]);

  const bank = workspace.value?.profile.bank;
  const confirmed = bank?.confirmed ?? 0;

  if (!bases) return <div class="empty compact muted">Loading base CVs...</div>;

  return (
    <div class="bases">
      <div class="bank-toolbar">
        <span class="muted">
          Base CVs are your starting points per career track. Tailored CVs (M3) start from one of
          them.
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="btn primary"
          disabled={confirmed === 0}
          title={confirmed === 0 ? "Confirm experience bank entries first" : undefined}
          onClick={() => setCreating(true)}
        >
          <Icon name="plus" size={14} /> New base CV
        </button>
      </div>
      {confirmed === 0 ? (
        <Notice kind="warning">
          Base CVs are written only from confirmed experience bank entries, and none are confirmed
          yet. <Link href="/profile/experience">Review the bank</Link>
        </Notice>
      ) : null}
      {bases.length === 0 ? (
        <EmptyState icon="text" title="No base CVs yet" compact>
          Most people want two: for example one for management roles and one for senior individual
          contributor roles.
        </EmptyState>
      ) : (
        <ul class="list card">
          {bases.map((b) => (
            <li key={b.id}>
              <Link class="list-row" href={basePath(b.id)}>
                <Icon name="text" size={14} />
                <span class="company">{b.label}</span>
                <span class="secondary truncate">{b.headline ?? ""}</span>
                <span class="meta">
                  {b.track ? (
                    <span class="badge">{b.track === "ic" ? "IC" : "Management"}</span>
                  ) : null}
                  {b.errors ? <span class="badge danger">{b.errors} problems</span> : null}
                  {!b.errors && b.warnings ? (
                    <span class="badge warning">{b.warnings} warnings</span>
                  ) : null}
                  <span>{formatDate(b.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <NewBaseDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(basePath(id));
          }}
        />
      ) : null}
    </div>
  );
}

/** A plain scalar from the draft's frontmatter, so controls follow unsaved edits. */
function frontmatterValue(text: string, key: string): string | undefined {
  const yaml = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return new RegExp(`^${key}:[ \\t]*(\\S+)[ \\t]*$`, "m").exec(yaml)?.[1];
}

/** Replaces or adds `key: value` in the YAML frontmatter of a CV file. */
function setFrontmatter(text: string, key: string, value: string): string {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return `---\n${key}: ${value}\n---\n\n${text}`;
  const yaml = match[1] ?? "";
  const line = new RegExp(`^${key}:.*$`, "m");
  const next = line.test(yaml)
    ? yaml.replace(line, `${key}: ${value}`)
    : `${yaml}\n${key}: ${value}`;
  return `---\n${next}\n---${text.slice(match[0].length)}`;
}

export function BaseEditor(props: { id: string }) {
  const { id } = props;
  const [detail, setDetail] = useState<BaseDetail | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"preview" | "pdf">("preview");
  const [pdf, setPdf] = useState<{ url: string; pages: number } | null>(null);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dirty = detail !== null && text !== detail.text;
  const revision = profileRevision.value;

  const load = async () => {
    try {
      const next = await api.base(id);
      setDetail(next);
      setText(next.text);
      setConflict(false);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  useEffect(() => {
    if (!dirty) void load();
  }, [id, revision]);

  const renderPdf = async () => {
    setPdfError(null);
    try {
      const res = await fetch(api.basePdfUrl(id, undefined, detail?.sha256));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `PDF rendering failed (${res.status})`);
      }
      const blob = await res.blob();
      setPdf((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return {
          url: URL.createObjectURL(blob),
          pages: Number(res.headers.get("x-pdf-pages")) || 0,
        };
      });
    } catch (e) {
      setPdfError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (view === "pdf" && detail) void renderPdf();
  }, [view, detail?.sha256]);

  const save = async () => {
    if (!detail || !dirty || busy) return;
    setBusy(true);
    try {
      const next = await api.saveBase(id, text, detail.sha256);
      setDetail(next);
      setText(next.text);
      toast("Saved", "success");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  useHotkeys([
    {
      keys: "mod+s",
      group: "Base CV",
      description: "Save",
      allowInInputs: true,
      run: () => void save(),
    },
  ]);

  if (!detail) return <div class="empty compact muted">Loading base CV...</div>;

  const errors = detail.issues.filter((i) => i.severity === "error");
  const theme = frontmatterValue(text, "theme") ?? detail.summary.theme;

  return (
    <div class="base-editor">
      <div class="base-editor-bar">
        <Link href="/profile/bases">
          <Icon name="arrowLeft" size={14} /> Base CVs
        </Link>
        <strong>{detail.summary.label}</strong>
        {detail.summary.track ? (
          <span class="badge">{detail.summary.track === "ic" ? "IC" : "Management"}</span>
        ) : null}
        <span class="spacer" />
        <label class="toggle">
          Theme
          <select
            class="select filter-select"
            value={theme}
            onChange={(e) => setText(setFrontmatter(text, "theme", e.currentTarget.value))}
          >
            <option value="classic">Classic</option>
            <option value="modern">Modern</option>
          </select>
        </label>
        <button
          type="button"
          class="btn danger small"
          onClick={async () => {
            if (!confirm(`Delete the base CV "${detail.summary.label}"?`)) return;
            try {
              await api.deleteBase(id);
              navigate("/profile/bases");
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          Delete
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          Save <Kbd keys="mod+s" />
        </button>
      </div>
      {conflict ? (
        <Notice kind="warning">
          This file changed on disk since you opened it.{" "}
          <button
            type="button"
            class="btn small"
            onClick={() => {
              if (!dirty || confirm("Discard your unsaved changes and reload?")) void load();
            }}
          >
            Reload
          </button>
        </Notice>
      ) : null}
      <div class="base-editor-panes">
        <div class="base-source">
          <textarea
            ref={editor}
            class="textarea mono base-text"
            spellcheck
            value={text}
            aria-label="CV Markdown"
            onInput={(e) => setText(e.currentTarget.value)}
          />
          <div class="base-issues">
            {detail.issues.length === 0 ? (
              <span class="muted">
                <Icon name="check" size={12} /> No problems. Every block cites the experience bank.
              </span>
            ) : (
              <ul class="diagnostics">
                {detail.issues.map((issue, i) => (
                  <li key={`${issue.line}-${i}`}>
                    <span
                      style={{
                        color: issue.severity === "error" ? "var(--danger)" : "var(--warning)",
                      }}
                    >
                      <Icon name="alert" size={12} title={issue.severity} />
                    </span>
                    <button
                      type="button"
                      class="link-button"
                      onClick={() => {
                        const area = editor.current;
                        if (!area) return;
                        const offset =
                          text
                            .split("\n")
                            .slice(0, issue.line - 1)
                            .join("\n").length + 1;
                        area.focus();
                        area.setSelectionRange(offset, offset);
                      }}
                    >
                      Line {issue.line}: {issue.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {dirty ? (
              <span class="muted">Unsaved changes. Problems and preview update when you save.</span>
            ) : null}
          </div>
          {detail.evidence.length ? (
            <div class="evidence-list">
              <span class="label">Cites</span>
              {detail.evidence.map((e) => (
                <span
                  key={e.id}
                  class={`chip evidence${e.confirmed ? "" : " unconfirmed"}`}
                  title={e.label}
                >
                  {e.id}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div class="base-preview">
          <div class="base-preview-bar">
            <fieldset class="btn-group">
              <legend class="visually-hidden">Preview</legend>
              <button
                type="button"
                class="btn small"
                aria-pressed={view === "preview"}
                onClick={() => setView("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                class="btn small"
                aria-pressed={view === "pdf"}
                onClick={() => setView("pdf")}
              >
                PDF
              </button>
            </fieldset>
            {view === "pdf" && pdf ? (
              <span class={pdf.pages > 2 ? "badge warning" : "badge"}>
                {pdf.pages} page{pdf.pages === 1 ? "" : "s"}
              </span>
            ) : null}
            <span class="spacer" />
            {errors.length ? <span class="badge danger">{errors.length} problems</span> : null}
            {view === "pdf" && pdf ? (
              <a class="btn small" href={pdf.url} download={`${id}.pdf`}>
                Download
              </a>
            ) : null}
          </div>
          {view === "preview" ? (
            // No sandbox attribute: the response's CSP already sandboxes the document (no scripts,
            // opaque origin), and some embedded browsers refuse to load sandboxed frames at all.
            <iframe
              key={detail.sha256}
              class="cv-frame"
              title="CV preview"
              src={api.basePreviewUrl(id, undefined, detail.sha256)}
            />
          ) : pdfError ? (
            <Notice kind="danger">{pdfError}</Notice>
          ) : pdf ? (
            // Fit the page to the width and hide the viewer's thumbnail strip.
            <iframe
              key={pdf.url}
              class="cv-frame"
              title="CV PDF"
              src={`${pdf.url}#view=FitH&navpanes=0`}
            />
          ) : (
            <div class="empty compact muted">Rendering the PDF...</div>
          )}
        </div>
      </div>
    </div>
  );
}
