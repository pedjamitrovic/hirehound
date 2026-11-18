import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ProfileFile } from "../../../shared/schemas/api.ts";
import { ApiError, errorMessage } from "../../api.ts";
import { Kbd, Notice } from "../../components/ui.tsx";
import { useHotkeys } from "../../hotkeys.ts";
import { profileRevision } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";

/* Shared by the profile forms (contact, preferences, answers): load, save, conflicts, fields. */

/** Field errors keyed by the value path the server reports, e.g. "links[0].url". */
export type FieldErrors = Record<string, string>;

export type ProfileFormOptions<T, D> = {
  /** Workspace path used in messages, e.g. "profile/contact.yaml". */
  fileName: string;
  load: () => Promise<ProfileFile<T>>;
  save: (value: unknown, expectedSha256: string | null) => Promise<ProfileFile<T>>;
  /** Form state for a loaded value; null means a missing, empty or invalid file. */
  toDraft: (value: T | null) => D;
  /** The value to save. `base` is the loaded value, so keys the form does not show survive. */
  toValue: (draft: D, base: T | null) => unknown;
  /** Tidies the draft before checking and saving, e.g. drops blank rows. */
  normalize?: (draft: D) => D;
  /** Client-side checks, keyed by the same paths the server reports. */
  validate?: (draft: D) => FieldErrors;
  /** True when the form shows the error for this path next to a field. */
  shows: (path: string) => boolean;
  onSaved?: (() => void) | undefined;
};

export type ProfileForm<T, D> = {
  file: ProfileFile<T> | null;
  loadError: string | null;
  draft: D;
  /** Replaces the draft and clears errors at or below the given paths. */
  update: (next: D, ...clear: string[]) => void;
  dirty: boolean;
  saving: boolean;
  /** The file changed on disk after it was loaded (seen while dirty, or a 409 on save). */
  stale: boolean;
  errors: FieldErrors;
  formError: string | null;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  discard: () => void;
  retry: () => void;
};

const FIX_FIELDS = "Not saved. Fix the fields marked in red.";

/** True when `path` is `prefix` or inside it ("links" covers "links[0].url"). */
export function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
}

/** The error at `prefix` or the first one inside it. */
export function errorAt(errors: FieldErrors, prefix: string): string | undefined {
  if (errors[prefix]) return errors[prefix];
  const key = Object.keys(errors).find((k) => within(k, prefix));
  return key === undefined ? undefined : errors[key];
}

/** "a, b,, c" -> ["a", "b", "c"]. */
export function splitList(text: string, separator: string | RegExp = ","): string[] {
  return text
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * A list edited as text. When the text is unchanged the original array is kept as is, so an
 * entry that itself contains the separator (hand-edited in YAML) is not split on save.
 */
export function listValue(
  text: string,
  original: readonly string[] | undefined,
  separator: "," | "\n" = ",",
): string[] {
  const joined = original?.join(separator === "," ? ", " : "\n");
  if (original && text === joined) return [...original];
  return splitList(text, separator === "," ? "," : /\r?\n/);
}

/**
 * Loads a profile YAML file into a form draft, saves it with optimistic concurrency and follows
 * changes on disk. A form with unsaved edits is never overwritten; it is told the file changed.
 */
export function useProfileFile<T, D>(options: ProfileFormOptions<T, D>): ProfileForm<T, D> {
  const opts = useRef(options);
  opts.current = options;
  const [file, setFile] = useState<ProfileFile<T> | null>(null);
  const [draft, setDraft] = useState<D>(() => options.toDraft(null));
  const [baseline, setBaseline] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const dirty = file !== null && JSON.stringify(draft) !== baseline;

  // Async callbacks read these instead of stale closures.
  const fileRef = useRef(file);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(false);
  /** Bumped whenever a file is applied; a load started before that is outdated. */
  const epochRef = useRef(0);
  fileRef.current = file;
  dirtyRef.current = dirty;

  const apply = (next: ProfileFile<T>) => {
    epochRef.current += 1;
    fileRef.current = next;
    dirtyRef.current = false;
    const fresh = opts.current.toDraft(next.value);
    setFile(next);
    setDraft(fresh);
    setBaseline(JSON.stringify(fresh));
    setStale(false);
    setErrors({});
    setFormError(null);
    setLoadError(null);
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Loads on mount, on retry, and whenever profile files change on disk.
  const revision = profileRevision.value;
  useEffect(() => {
    let cancelled = false;
    const epoch = epochRef.current;
    opts.current.load().then(
      (next) => {
        if (cancelled || epoch !== epochRef.current || savingRef.current) return;
        const current = fileRef.current;
        if (current && current.sha256 === next.sha256) return;
        if (current && dirtyRef.current) setStale(true);
        else applyRef.current(next);
      },
      (error: unknown) => {
        if (!cancelled && fileRef.current === null) setLoadError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [revision, attempt]);

  /** After a failed save, take the user to the first field that needs fixing. */
  const focusFirstInvalid = () =>
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });

  const save = async () => {
    const o = opts.current;
    const current = fileRef.current;
    if (!current || savingRef.current || (!dirty && !current.empty)) return;
    const clean = o.normalize ? o.normalize(draft) : draft;
    if (clean !== draft) setDraft(clean);
    const problems = o.validate?.(clean) ?? {};
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      setFormError(FIX_FIELDS);
      focusFirstInvalid();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      apply(await o.save(o.toValue(clean, current.value), current.sha256));
      toast("Saved", "success");
      o.onSaved?.();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setStale(true);
      } else if (error instanceof ApiError && error.status === 400 && error.issues.length > 0) {
        setErrors(Object.fromEntries(error.issues.map((i) => [i.path, i.message])));
        focusFirstInvalid();
        const other = error.issues.filter((i) => !o.shows(i.path));
        setFormError(
          other.length > 0
            ? `Not saved. ${other.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`
            : FIX_FIELDS,
        );
      } else {
        setFormError(`Not saved. ${errorMessage(error)}`);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reload = async () => {
    if (
      dirtyRef.current &&
      !window.confirm("Discard your unsaved changes and load the version on disk?")
    ) {
      return;
    }
    try {
      apply(await opts.current.load());
    } catch (error) {
      toast(`Could not reload: ${errorMessage(error)}`, "error");
    }
  };

  const discard = () => {
    const current = fileRef.current;
    if (!current) return;
    setDraft(opts.current.toDraft(current.value));
    setErrors({});
    setFormError(null);
  };

  const update = (next: D, ...clear: string[]) => {
    setDraft(next);
    setFormError(null);
    if (clear.length === 0) return;
    setErrors((prev) => {
      const keep = Object.entries(prev).filter(([k]) => !clear.some((c) => within(k, c)));
      return keep.length === Object.keys(prev).length ? prev : Object.fromEntries(keep);
    });
  };

  const retry = () => {
    setLoadError(null);
    setAttempt((n) => n + 1);
  };

  useHotkeys([
    {
      keys: "mod+s",
      group: "Profile",
      description: "Save",
      allowInInputs: true,
      run: () => void save(),
    },
  ]);

  return {
    file,
    loadError,
    draft,
    update,
    dirty,
    saving,
    stale,
    errors,
    formError,
    save,
    reload,
    discard,
    retry,
  };
}

/** Placeholder card while the file loads, or the reason it could not be loaded. */
export function ProfileLoading(props: {
  title: string;
  fileName: string;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section class="card">
      <header class="card-header">
        <h2>{props.title}</h2>
      </header>
      <div class="card-body">
        {props.error ? (
          <Notice kind="danger">
            Could not load {props.fileName}. {props.error}{" "}
            <button type="button" class="btn small" onClick={props.onRetry}>
              Try again
            </button>
          </Notice>
        ) : (
          <span class="muted">Loading...</span>
        )}
      </div>
    </section>
  );
}

/** Problems found in the file on disk, with file:line for each. */
export function FileProblems(props: { file: ProfileFile<unknown>; fileName: string }) {
  const { file, fileName } = props;
  if (file.diagnostics.length === 0) return null;
  const invalid = file.value === null && !file.empty;
  return (
    <Notice kind={invalid ? "danger" : "warning"}>
      <p>
        {invalid
          ? `${fileName} has problems, so this form starts empty. Saving replaces the file with what you enter here.`
          : `Hirehound ignores these lines in ${fileName}. Saving from here removes them.`}
      </p>
      <ul class="form-diagnostics">
        {file.diagnostics.map((d, i) => (
          <li key={`${d.line ?? 0}:${d.message}:${i}`}>
            <code>
              {d.file}
              {d.line ? `:${d.line}` : ""}
            </code>{" "}
            {d.message}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

type SaveBarForm = Pick<
  ProfileForm<unknown, unknown>,
  "file" | "dirty" | "saving" | "stale" | "formError" | "reload" | "discard"
>;

/**
 * Save button, status and save problems. Sticks to the bottom of the scroll area so it stays
 * visible on long forms. `standalone` draws it as its own box instead of a card footer.
 */
export function SaveBar(props: { form: SaveBarForm; fileName: string; standalone?: boolean }) {
  const { form, fileName } = props;
  const status = form.dirty
    ? "Unsaved changes"
    : form.file?.value
      ? `Stored in ${fileName}`
      : "Not saved yet";
  return (
    <div class={`form-savebar${props.standalone ? " standalone" : ""}`}>
      {form.stale ? (
        <Notice kind="warning">
          {fileName} changed on disk since you opened it. Reload to get the latest version
          {form.dirty ? "; your unsaved changes here will be lost" : ""}.{" "}
          <button type="button" class="btn small" onClick={() => void form.reload()}>
            Reload
          </button>
        </Notice>
      ) : null}
      {form.formError ? <Notice kind="danger">{form.formError}</Notice> : null}
      <div class="form-savebar-row">
        <span class="form-status">{status}</span>
        <span class="spacer" />
        {form.dirty ? (
          <button type="button" class="btn ghost" disabled={form.saving} onClick={form.discard}>
            Discard changes
          </button>
        ) : null}
        <button
          type="submit"
          class="btn primary"
          disabled={(!form.dirty && !form.file?.empty) || form.saving}
        >
          {form.saving ? "Saving..." : "Save"} <Kbd keys="mod+s" />
        </button>
      </div>
    </div>
  );
}

/** Labelled text input with hint and error, wired up for screen readers. */
export function TextField(props: {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  error?: string | undefined;
  hint?: ComponentChildren;
  placeholder?: string;
  type?: "text" | "email" | "tel" | "url" | "number";
  autocomplete?: string;
  inputmode?: "text" | "numeric" | "decimal" | "email" | "tel" | "url";
  maxlength?: number;
  list?: string;
  class?: string;
  min?: number;
  max?: number;
}) {
  const describedBy = [props.error ? `${props.id}-error` : "", props.hint ? `${props.id}-hint` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={props.class ? `field ${props.class}` : "field"}>
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        class="input"
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        inputmode={props.inputmode}
        maxlength={props.maxlength}
        list={props.list}
        min={props.min}
        max={props.max}
        aria-invalid={props.error ? "true" : undefined}
        aria-describedby={describedBy || undefined}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      {props.error ? (
        <span class="error" id={`${props.id}-error`}>
          {props.error}
        </span>
      ) : null}
      {props.hint ? (
        <span class="hint" id={`${props.id}-hint`}>
          {props.hint}
        </span>
      ) : null}
    </div>
  );
}

/** Checkbox with its label and an optional hint underneath. */
export function Check(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span>
        {props.label}
        {props.hint ? <span class="hint">{props.hint}</span> : null}
      </span>
    </label>
  );
}

/* ---------- Contact ---------- */
