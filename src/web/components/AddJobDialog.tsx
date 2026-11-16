import { useEffect, useRef, useState } from "preact/hooks";
import { EMPLOYMENT_TYPES, WORKPLACES } from "../../shared/enums.ts";
import type { PostingDraft } from "../../shared/schemas/api.ts";
import type { EmploymentType, Workplace } from "../../shared/schemas/posting.ts";
import { STATE_LABELS } from "../../shared/states.ts";
import { ApiError, api, errorMessage } from "../api.ts";
import { jobPath, navigate } from "../router.ts";
import { upsertJob } from "../state/store.ts";
import { toast } from "../state/toasts.ts";
import { Dialog } from "./Dialog.tsx";
import { Kbd, Link, Notice } from "./ui.tsx";

type Mode = "url" | "text";

type Fields = {
  company: string;
  title: string;
  location: string;
  workplace: Workplace;
  employmentType: EmploymentType;
};

const EMPTY: Fields = {
  company: "",
  title: "",
  location: "",
  workplace: "unknown",
  employmentType: "unknown",
};

const WORKPLACE_LABELS: Record<Workplace, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On site",
  unknown: "Not stated",
};

const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  "full-time": "Full time",
  "part-time": "Part time",
  contract: "Contract",
  internship: "Internship",
  unknown: "Not stated",
};

function JobFields(props: {
  fields: Fields;
  onChange: (fields: Fields) => void;
  errors: Record<string, string>;
}) {
  const { fields, onChange, errors } = props;
  const set = (patch: Partial<Fields>) => onChange({ ...fields, ...patch });
  return (
    <div class="form-grid">
      <div class="field">
        <label for="job-company">Company</label>
        <input
          id="job-company"
          class="input"
          value={fields.company}
          aria-invalid={errors.company ? "true" : undefined}
          onInput={(e) => set({ company: e.currentTarget.value })}
        />
        {errors.company ? <span class="error">{errors.company}</span> : null}
      </div>
      <div class="field">
        <label for="job-title">Role</label>
        <input
          id="job-title"
          class="input"
          value={fields.title}
          aria-invalid={errors.title ? "true" : undefined}
          onInput={(e) => set({ title: e.currentTarget.value })}
        />
        {errors.title ? <span class="error">{errors.title}</span> : null}
      </div>
      <div class="field">
        <label for="job-location">Location</label>
        <input
          id="job-location"
          class="input"
          placeholder="e.g. Berlin, or Remote (EU)"
          value={fields.location}
          onInput={(e) => set({ location: e.currentTarget.value })}
        />
      </div>
      <div class="form-grid" style={{ gap: "8px" }}>
        <div class="field">
          <label for="job-workplace">Workplace</label>
          <select
            id="job-workplace"
            class="select"
            value={fields.workplace}
            onChange={(e) => set({ workplace: e.currentTarget.value as Workplace })}
          >
            {WORKPLACES.map((w) => (
              <option key={w} value={w}>
                {WORKPLACE_LABELS[w]}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="job-type">Type</label>
          <select
            id="job-type"
            class="select"
            value={fields.employmentType}
            onChange={(e) => set({ employmentType: e.currentTarget.value as EmploymentType })}
          >
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYMENT_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/** Add a job from a link (fetched and snapshotted) or from pasted text. Nothing is AI here. */
export function AddJobDialog(props: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [textUrl, setTextUrl] = useState("");
  const [draft, setDraft] = useState<PostingDraft | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showText, setShowText] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode === "url") urlInput.current?.focus();
    else textInput.current?.focus();
  }, [mode]);

  const fetchDraft = async () => {
    if (!url.trim() || fetching) return;
    setFetching(true);
    setError(null);
    setDraft(null);
    try {
      const result = await api.preview(url.trim());
      setDraft(result);
      setFields({
        company: result.company ?? "",
        title: result.title ?? "",
        location: result.location ?? "",
        workplace: result.workplace,
        employmentType: result.employmentType,
      });
      setErrors({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (saving) return;
    if (mode === "url" && !draft) {
      void fetchDraft();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const common = {
        company: fields.company,
        title: fields.title,
        ...(fields.location.trim() ? { location: fields.location.trim() } : {}),
        workplace: fields.workplace,
        employmentType: fields.employmentType,
      };
      const detail =
        mode === "url" && draft
          ? await api.createJob({ kind: "url", token: draft.token, ...common })
          : await api.createJob({
              kind: "text",
              text,
              ...(textUrl.trim() ? { url: textUrl.trim() } : {}),
              ...common,
            });
      upsertJob(detail.summary);
      toast(`Added ${detail.summary.company}: ${detail.summary.title}`, "success");
      props.onClose();
      navigate(jobPath(detail.summary.id));
    } catch (e) {
      if (e instanceof ApiError && e.issues.length) {
        setErrors(Object.fromEntries(e.issues.map((i) => [i.path, i.message])));
      }
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "snapshot-expired") setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  const switchToText = () => {
    setMode("text");
    if (!textUrl && url) setTextUrl(url);
    if (draft?.text && !text) setText(draft.text);
    setError(null);
  };

  const canSave =
    !saving &&
    fields.company.trim() !== "" &&
    fields.title.trim() !== "" &&
    (mode === "url" ? draft !== null : text.trim().length >= 20);

  return (
    <Dialog
      title="Add a job"
      wide
      onClose={props.onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <span class="muted">
            Nothing is sent to AI. The posting is saved as files in your workspace.
          </span>
          <span class="spacer" />
          <button type="button" class="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" class="btn primary" disabled={!canSave} onClick={() => void save()}>
            Add job <Kbd keys="mod+enter" />
          </button>
        </>
      }
    >
      <fieldset class="btn-group">
        <legend class="visually-hidden">How to add the job</legend>
        <button
          type="button"
          class="btn"
          aria-pressed={mode === "url"}
          onClick={() => setMode("url")}
        >
          From a link
        </button>
        <button type="button" class="btn" aria-pressed={mode === "text"} onClick={switchToText}>
          Paste text
        </button>
      </fieldset>

      {mode === "url" ? (
        <>
          <div class="field">
            <label for="job-url">Posting link</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                id="job-url"
                ref={urlInput}
                class="input"
                type="url"
                placeholder="https://boards.greenhouse.io/company/jobs/123"
                value={url}
                onInput={(e) => {
                  setUrl(e.currentTarget.value);
                  if (draft) setDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    void fetchDraft();
                  }
                }}
              />
              <button
                type="button"
                class="btn"
                disabled={!url.trim() || fetching}
                onClick={() => void fetchDraft()}
              >
                {fetching ? "Fetching..." : "Fetch"}
              </button>
            </div>
            <span class="hint">
              Works best with company career pages and Greenhouse, Lever, Ashby or Workable links.
              LinkedIn needs the text pasted.
            </span>
          </div>
          {error ? (
            <Notice kind="danger">
              {error}{" "}
              <button type="button" class="btn small" onClick={switchToText}>
                Paste text instead
              </button>
            </Notice>
          ) : null}
          {draft ? (
            <>
              {draft.duplicates.length ? (
                <Notice kind="warning">
                  Already in your pipeline:{" "}
                  {draft.duplicates.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 ? ", " : ""}
                      <Link href={jobPath(d.id)} onClick={props.onClose}>
                        {d.company}: {d.title}
                      </Link>{" "}
                      ({STATE_LABELS[d.state]})
                    </span>
                  ))}
                </Notice>
              ) : null}
              {draft.warnings.map((w) => (
                <Notice key={w} kind="warning">
                  {w}
                </Notice>
              ))}
              <JobFields fields={fields} onChange={setFields} errors={errors} />
              <div class="field">
                <span class="label">
                  Posting text{" "}
                  <span class="muted">({draft.text.length.toLocaleString()} characters)</span>{" "}
                  <button
                    type="button"
                    class="btn ghost small"
                    onClick={() => setShowText(!showText)}
                  >
                    {showText ? "Hide" : "Show"}
                  </button>
                </span>
                {showText ? (
                  <pre class="posting-preview">{draft.text}</pre>
                ) : (
                  <p class="muted truncate">{draft.text.slice(0, 200)}</p>
                )}
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <div class="field">
            <label for="job-text">Posting text</label>
            <textarea
              id="job-text"
              ref={textInput}
              class="textarea"
              style={{ minHeight: "180px" }}
              placeholder="Paste the full job posting"
              value={text}
              aria-invalid={errors.text ? "true" : undefined}
              onInput={(e) => setText(e.currentTarget.value)}
            />
            {errors.text ? <span class="error">{errors.text}</span> : null}
          </div>
          <JobFields fields={fields} onChange={setFields} errors={errors} />
          <div class="field">
            <label for="job-text-url">Link (optional)</label>
            <input
              id="job-text-url"
              class="input"
              type="url"
              value={textUrl}
              onInput={(e) => setTextUrl(e.currentTarget.value)}
            />
          </div>
          {error ? <Notice kind="danger">{error}</Notice> : null}
        </>
      )}
    </Dialog>
  );
}
