import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ProfileFile } from "../../../shared/schemas/api.ts";
import type { Achievement, BankFile, BankKind } from "../../../shared/schemas/bank.ts";
import { ApiError, api, type BankOpInput, errorMessage } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { EmptyState, Notice } from "../../components/ui.tsx";
import { profileRevision } from "../../state/store.ts";
import { toast } from "../../state/toasts.ts";
import { DiagnosticList } from "../Settings.tsx";
import { FIELDS, type FieldDef, fromFormValue, KIND_LABELS, toFormValue } from "./bank-fields.ts";

type AnyEntry = Record<string, unknown> & { id: string; confirmed: boolean; source?: string };

type Editing =
  | { mode: "edit"; kind: BankKind; entry: AnyEntry }
  | { mode: "new"; kind: BankKind; parent?: string };

const SECTIONS: { kind: Exclude<BankKind, "achievement">; key: keyof BankFile; title: string }[] = [
  { kind: "role", key: "roles", title: "Roles" },
  { kind: "project", key: "projects", title: "Projects" },
  { kind: "education", key: "education", title: "Education" },
  { kind: "certification", key: "certifications", title: "Certifications" },
  { kind: "skill", key: "skills", title: "Skills" },
  { kind: "language", key: "languages", title: "Languages" },
  { kind: "award", key: "awards", title: "Awards" },
];

function period(entry: AnyEntry): string {
  const start = entry.start as string | undefined;
  const end = entry.end as string | undefined;
  if (!start && !end) return "";
  return `${start ?? "?"} - ${end ?? "?"}`;
}

function headline(kind: BankKind, e: AnyEntry): string {
  switch (kind) {
    case "role":
      return `${e.title} at ${e.company}`;
    case "achievement":
      return String(e.text);
    case "education":
      return [e.degree, e.field, e.institution].filter(Boolean).join(", ");
    case "skill":
      return `${e.name}: ${((e.items as string[]) ?? []).join(", ")}`;
    case "language":
      return e.level ? `${e.name} (${e.level})` : String(e.name);
    default:
      return String(e.name);
  }
}

function matches(query: string, entry: AnyEntry): boolean {
  if (!query) return true;
  return JSON.stringify(entry).toLowerCase().includes(query.toLowerCase());
}

function EntryForm(props: {
  editing: Editing;
  busy: boolean;
  onCancel: () => void;
  onSave: (entry: Record<string, unknown>) => void;
}) {
  const { editing } = props;
  const fields = FIELDS[editing.kind];
  const initial: Record<string, unknown> = editing.mode === "edit" ? editing.entry : {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, toFormValue(f, initial[f.key])])),
  );
  const missing = fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);

  const submit = () => {
    if (missing.length) return;
    const base: Record<string, unknown> =
      editing.mode === "edit"
        ? Object.fromEntries(
            Object.entries(editing.entry).filter(
              ([key]) => key !== "achievements" && !fields.some((f) => f.key === key),
            ),
          )
        : { source: "manual" };
    const next: Record<string, unknown> = { ...base };
    for (const field of fields) {
      const value = fromFormValue(field, values[field.key] ?? "");
      if (value !== undefined) next[field.key] = value;
    }
    // Writing or editing an entry yourself is a review: it is confirmed.
    next.confirmed = true;
    props.onSave(next);
  };

  const input = (field: FieldDef) => {
    const common = {
      id: `bank-${field.key}`,
      value: values[field.key] ?? "",
      placeholder: field.placeholder,
      onInput: (e: Event) =>
        setValues({ ...values, [field.key]: (e.currentTarget as HTMLInputElement).value }),
    };
    if (field.type === "select") {
      return (
        <select {...common} class="select">
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o || "Not stated"}
            </option>
          ))}
        </select>
      );
    }
    if (field.type === "textarea" || (field.type === "list" && field.separator === "lines")) {
      return <textarea {...common} class="textarea" rows={field.key === "text" ? 2 : 3} />;
    }
    return <input {...common} class="input" />;
  };

  return (
    <form
      class="bank-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div class="form-grid">
        {fields.map((field) => (
          <div key={field.key} class={`field${field.wide ? " span-2" : ""}`}>
            <label for={`bank-${field.key}`}>
              {field.label}
              {field.required ? " *" : ""}
            </label>
            {input(field)}
            {field.hint ? <span class="hint">{field.hint}</span> : null}
          </div>
        ))}
      </div>
      <div class="bank-form-actions">
        {missing.length ? <span class="muted">Required: {missing.join(", ")}</span> : null}
        <span class="spacer" />
        <button type="button" class="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="btn primary" disabled={props.busy || missing.length > 0}>
          {editing.mode === "new" ? `Add ${KIND_LABELS[editing.kind].toLowerCase()}` : "Save"}
        </button>
      </div>
    </form>
  );
}

function EntryRow(props: {
  kind: BankKind;
  entry: AnyEntry;
  busy: boolean;
  children?: ComponentChildren;
  onConfirm: (value: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { kind, entry } = props;
  const metrics = (entry.metrics as string[] | undefined) ?? [];
  const skills = (entry.skills as string[] | undefined) ?? [];
  return (
    <div class={`bank-row bank-${kind}`} data-confirmed={entry.confirmed ? "true" : "false"}>
      <input
        type="checkbox"
        class="bank-confirm"
        checked={entry.confirmed}
        disabled={props.busy}
        title={
          entry.confirmed
            ? "Confirmed: CVs may use this"
            : "Not confirmed yet: CVs will not use this"
        }
        aria-label={`Confirmed ${entry.id}`}
        onChange={(e) => props.onConfirm(e.currentTarget.checked)}
      />
      <div class="bank-main">
        <div class="bank-title">
          <span>{headline(kind, entry)}</span>
          {!entry.confirmed ? <span class="badge warning">To review</span> : null}
        </div>
        <div class="bank-meta">
          <code class="bank-id">{entry.id}</code>
          {period(entry) ? <span>{period(entry)}</span> : null}
          {entry.location ? <span>{String(entry.location)}</span> : null}
          {entry.source ? (
            <span class="muted" title="Where this came from">
              {String(entry.source).replace(/^imports\//, "")}
            </span>
          ) : null}
        </div>
        {kind === "role" && entry.summary ? <p class="bank-text">{String(entry.summary)}</p> : null}
        {metrics.length || skills.length ? (
          <div class="bank-chips">
            {metrics.map((m) => (
              <span key={m} class="chip metric">
                {m}
              </span>
            ))}
            {skills.map((s) => (
              <span key={s} class="chip">
                {s}
              </span>
            ))}
          </div>
        ) : null}
        {entry.detail ? <p class="bank-detail">{String(entry.detail)}</p> : null}
        {props.children}
      </div>
      <div class="bank-actions">
        <button
          type="button"
          class="btn ghost icon small"
          aria-label={`Edit ${entry.id}`}
          onClick={props.onEdit}
        >
          <Icon name="note" size={14} />
        </button>
        <button
          type="button"
          class="btn ghost icon small"
          aria-label={`Delete ${entry.id}`}
          disabled={props.busy}
          onClick={props.onDelete}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Structured editor for profile/experience-bank.yaml. Every change is a small operation on the
 * server, which keeps ids stable, never reuses them, and preserves comments in the file.
 */
export function BankEditor(props: {
  initialFilter?: "all" | "review";
  onChange?: (bank: BankFile | null) => void;
}) {
  const [file, setFile] = useState<ProfileFile<BankFile> | null>(null);
  const [filter, setFilter] = useState<"all" | "review">(props.initialFilter ?? "all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const load = async () => {
    try {
      const next = await api.bank();
      setFile(next);
      setConflict(false);
      props.onChange?.(next.value);
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };

  // Reload when the file changes on disk, unless a form is open.
  const revision = profileRevision.value;
  useEffect(() => {
    if (!editing) void load();
  }, [revision]);

  const bank = file?.value ?? null;

  const apply = async (ops: BankOpInput[], success?: string) => {
    if (!file) return false;
    setBusy(true);
    try {
      const next = await api.bankOps(ops, file.sha256);
      setFile(next);
      props.onChange?.(next.value);
      if (success) toast(success, "success");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "changed-on-disk") {
        setConflict(true);
      }
      toast(errorMessage(error), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const all = useMemo(() => {
    const list: { kind: BankKind; entry: AnyEntry }[] = [];
    if (!bank) return list;
    for (const section of SECTIONS) {
      for (const entry of bank[section.key] as unknown as AnyEntry[]) {
        list.push({ kind: section.kind, entry });
        for (const a of (entry.achievements as AnyEntry[] | undefined) ?? []) {
          list.push({ kind: "achievement", entry: a });
        }
      }
    }
    return list;
  }, [bank]);
  const unconfirmed = all.filter((e) => !e.entry.confirmed);

  const visible = (entry: AnyEntry, children: AnyEntry[] = []) =>
    (filter === "all" || !entry.confirmed || children.some((c) => !c.confirmed)) &&
    (matches(query, entry) || children.some((c) => matches(query, c)));

  const save = async (entry: Record<string, unknown>) => {
    if (!editing) return;
    const ok = await apply(
      [
        {
          op: "upsert",
          kind: editing.kind,
          entry,
          ...(editing.mode === "new" && editing.parent ? { parent: editing.parent } : {}),
        },
      ],
      editing.mode === "new" ? "Added" : "Saved",
    );
    if (ok) setEditing(null);
  };

  const remove = (entry: AnyEntry, kind: BankKind) => {
    const extra = kind === "role" || kind === "project" ? " and its achievements" : "";
    if (
      !confirm(
        `Delete ${entry.id}${extra}? The id is never reused; CVs that cite it will show it as missing.`,
      )
    ) {
      return;
    }
    void apply([{ op: "delete", id: entry.id }], `Deleted ${entry.id}`);
  };

  const formFor = (match: (e: Editing) => boolean) =>
    editing && match(editing) ? (
      <EntryForm
        editing={editing}
        busy={busy}
        onCancel={() => setEditing(null)}
        onSave={(e) => void save(e)}
      />
    ) : null;

  if (!file) return <div class="empty compact muted">Loading the experience bank...</div>;

  return (
    <div class="bank">
      {file.diagnostics.some((d) => d.severity === "error") ? (
        <Notice kind="danger">
          <strong>experience-bank.yaml has problems.</strong> Fix them in the file to edit here.
          <DiagnosticList items={file.diagnostics} />
        </Notice>
      ) : null}
      {conflict ? (
        <Notice kind="warning">
          The bank changed on disk while you were editing.{" "}
          <button type="button" class="btn small" onClick={() => void load()}>
            Reload
          </button>
        </Notice>
      ) : null}

      <div class="bank-toolbar">
        <fieldset class="btn-group">
          <legend class="visually-hidden">Show</legend>
          <button
            type="button"
            class="btn small"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All ({all.length})
          </button>
          <button
            type="button"
            class="btn small"
            aria-pressed={filter === "review"}
            onClick={() => setFilter("review")}
          >
            To review ({unconfirmed.length})
          </button>
        </fieldset>
        <input
          class="input filter-input"
          type="search"
          placeholder="Search entries"
          aria-label="Search entries"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        {unconfirmed.length > 0 ? (
          <button
            type="button"
            class="btn small"
            disabled={busy}
            onClick={() => {
              const ids = unconfirmed.filter((e) => matches(query, e.entry)).map((e) => e.entry.id);
              if (
                ids.length &&
                confirm(
                  `Confirm ${ids.length} entries? Only confirm what you have read and know to be true.`,
                )
              ) {
                void apply(
                  [{ op: "confirm", ids, confirmed: true }],
                  `Confirmed ${ids.length} entries`,
                );
              }
            }}
          >
            <Icon name="check" size={14} /> Confirm all shown
          </button>
        ) : null}
        <span class="spacer" />
        <select
          class="select filter-select"
          aria-label="Add an entry"
          value=""
          onChange={(e) => {
            const kind = e.currentTarget.value as BankKind;
            e.currentTarget.value = "";
            if (kind) setEditing({ mode: "new", kind });
          }}
        >
          <option value="">Add...</option>
          {SECTIONS.map((s) => (
            <option key={s.kind} value={s.kind}>
              {KIND_LABELS[s.kind]}
            </option>
          ))}
        </select>
      </div>

      {formFor((e) => e.mode === "new" && !e.parent)}

      {all.length === 0 ? (
        <EmptyState icon="profile" title="Your experience bank is empty" compact>
          Import your existing CVs in onboarding and Hirehound drafts it for you, or add entries by
          hand. Every claim a CV makes will cite an entry from here.
        </EmptyState>
      ) : null}

      {SECTIONS.map((section) => {
        const entries = (bank?.[section.key] as unknown as AnyEntry[] | undefined) ?? [];
        const shown = entries.filter((e) =>
          visible(e, (e.achievements as AnyEntry[] | undefined) ?? []),
        );
        if (shown.length === 0) return null;
        return (
          <section key={section.key} class="bank-section">
            <h3>
              {section.title} <span class="muted">{entries.length}</span>
            </h3>
            {shown.map((entry) => {
              const achievements = ((entry.achievements as AnyEntry[] | undefined) ?? []).filter(
                (a) =>
                  (filter === "all" || !a.confirmed || !entry.confirmed) &&
                  (matches(query, a) || matches(query, entry)),
              );
              const nested = section.kind === "role" || section.kind === "project";
              return (
                <div key={entry.id} class="bank-card">
                  {editing?.mode === "edit" && editing.entry.id === entry.id ? (
                    formFor(() => true)
                  ) : (
                    <EntryRow
                      kind={section.kind}
                      entry={entry}
                      busy={busy}
                      onConfirm={(value) =>
                        void apply([{ op: "confirm", ids: [entry.id], confirmed: value }])
                      }
                      onEdit={() => setEditing({ mode: "edit", kind: section.kind, entry })}
                      onDelete={() => remove(entry, section.kind)}
                    />
                  )}
                  {nested ? (
                    <div class="bank-achievements">
                      {achievements.map((a) =>
                        editing?.mode === "edit" && editing.entry.id === a.id ? (
                          <div key={a.id}>{formFor(() => true)}</div>
                        ) : (
                          <EntryRow
                            key={a.id}
                            kind="achievement"
                            entry={a as AnyEntry & Achievement}
                            busy={busy}
                            onConfirm={(value) =>
                              void apply([{ op: "confirm", ids: [a.id], confirmed: value }])
                            }
                            onEdit={() =>
                              setEditing({ mode: "edit", kind: "achievement", entry: a })
                            }
                            onDelete={() => remove(a, "achievement")}
                          />
                        ),
                      )}
                      {formFor((e) => e.mode === "new" && e.parent === entry.id) ?? (
                        <button
                          type="button"
                          class="btn ghost small bank-add"
                          onClick={() =>
                            setEditing({ mode: "new", kind: "achievement", parent: entry.id })
                          }
                        >
                          <Icon name="plus" size={12} /> Add achievement
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
