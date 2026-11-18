import { useEffect, useState } from "preact/hooks";
import type { Answer, AnswersFile } from "../../../shared/schemas/answers.ts";
import { slugify } from "../../../shared/slug.ts";
import { localIsoDate } from "../../../shared/time.ts";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { EmptyState } from "../../components/ui.tsx";
import {
  Check,
  type FieldErrors,
  FileProblems,
  listValue,
  ProfileLoading,
  SaveBar,
  useProfileFile,
} from "./profile-form.tsx";

const ANSWERS_FILE = "profile/answers.yaml";

type Kind = Answer["kind"];

// Literal copy of the schema enum: the schemas are Zod values and stay out of the bundle.
const KINDS: { value: Kind; label: string; placeholder: string }[] = [
  { value: "text", label: "Text", placeholder: "" },
  { value: "yes-no", label: "Yes or no", placeholder: "Yes" },
  { value: "number", label: "Number", placeholder: "30" },
  { value: "choice", label: "Choice", placeholder: "The option to pick" },
  { value: "url", label: "Link", placeholder: "https://" },
  { value: "date", label: "Date", placeholder: "YYYY-MM-DD" },
];

type Row = {
  /** Stable key for rendering: "saved-<id>" for loaded answers, "new-<n>" for added ones. */
  key: string;
  /** The id in answers.yaml; null for answers added here (derived from the question on save). */
  id: string | null;
  question: string;
  answer: string;
  kind: Kind;
  tags: string;
  sensitive: boolean;
  aliases: string;
};

let newRows = 0;

function emptyRow(): Row {
  newRows += 1;
  return {
    key: `new-${newRows}`,
    id: null,
    question: "",
    answer: "",
    kind: "text",
    tags: "",
    sensitive: false,
    aliases: "",
  };
}

function answersDraft(value: AnswersFile | null): Row[] {
  return (value?.answers ?? []).map((a) => ({
    key: `saved-${a.id}`,
    id: a.id,
    question: a.question,
    answer: a.answer,
    kind: a.kind,
    tags: a.tags.join(", "),
    sensitive: a.sensitive,
    aliases: a.aliases.join("\n"),
  }));
}

/** Existing ids stay; new answers get a unique slug of their question ("" while it is empty). */
function assignIds(rows: Row[]): string[] {
  const taken = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
  return rows.map((row) => {
    if (row.id) return row.id;
    if (row.question.trim() === "") return "";
    const base = slugify(row.question, 40);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  });
}

const isBlank = (row: Row) =>
  row.question.trim() === "" &&
  row.answer.trim() === "" &&
  row.tags.trim() === "" &&
  row.aliases.trim() === "";

function answersErrors(rows: Row[]): FieldErrors {
  const errors: FieldErrors = {};
  rows.forEach((row, i) => {
    if (row.question.trim() === "") errors[`answers[${i}].question`] = "Add the question";
  });
  return errors;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function answersValue(rows: Row[], base: AnswersFile | null): unknown {
  const ids = assignIds(rows);
  const before = new Map((base?.answers ?? []).map((a) => [a.id, a]));
  const today = localIsoDate();
  return {
    ...base,
    version: 1,
    answers: rows.map((row, i) => {
      const original = row.id ? before.get(row.id) : undefined;
      const next = {
        id: ids[i] ?? "",
        question: row.question.trim(),
        aliases: listValue(row.aliases, original?.aliases, "\n"),
        answer: row.answer.trim(),
        kind: row.kind,
        tags: listValue(row.tags, original?.tags),
        sensitive: row.sensitive,
      };
      const unchanged =
        original !== undefined &&
        original.question === next.question &&
        original.answer === next.answer &&
        original.kind === next.kind &&
        original.sensitive === next.sensitive &&
        sameList(original.aliases, next.aliases) &&
        sameList(original.tags, next.tags);
      return { ...original, ...next, updated_at: unchanged ? original?.updated_at : today };
    }),
  };
}

const showsAnswers = (path: string) =>
  /^answers\[\d+\]\.(id|question|answer|kind|tags|aliases|sensitive)\b/.test(path);

/** The error for one field of one answer, e.g. answers[2].question or answers[2].tags[0]. */
const rowError = (errors: FieldErrors, i: number, field: string) =>
  errors[`answers[${i}].${field}`] ??
  Object.entries(errors).find(([k]) => k.startsWith(`answers[${i}].${field}[`))?.[1];

/** Reusable answers for application forms (profile/answers.yaml). */
export function AnswersEditor(props: { onSaved?: () => void }) {
  const form = useProfileFile<AnswersFile, Row[]>({
    fileName: ANSWERS_FILE,
    load: api.answers,
    save: api.saveAnswers,
    toDraft: answersDraft,
    toValue: answersValue,
    normalize: (rows) => (rows.some(isBlank) ? rows.filter((r) => !isBlank(r)) : rows),
    validate: answersErrors,
    shows: showsAnswers,
    onSaved: props.onSaved,
  });
  const [focusKey, setFocusKey] = useState<string | null>(null);

  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(`answer-q-${focusKey}`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  if (!form.file) {
    return (
      <ProfileLoading
        title="Saved answers"
        fileName={ANSWERS_FILE}
        error={form.loadError}
        onRetry={form.retry}
      />
    );
  }

  const rows = form.draft;
  const e = form.errors;
  const ids = assignIds(rows);

  const add = () => {
    const row = emptyRow();
    form.update([...rows, row]);
    setFocusKey(row.key);
  };
  const setRow = (index: number, patch: Partial<Row>, field: string) =>
    form.update(
      rows.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      `answers[${index}].${field}`,
    );
  // Indexes shift after a removal, so errors from the last save no longer line up.
  const remove = (index: number) =>
    form.update(
      rows.filter((_, i) => i !== index),
      "answers",
    );

  return (
    <form
      class="form-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <section class="card">
        <header class="card-header">
          <h2>Saved answers{rows.length ? ` (${rows.length})` : ""}</h2>
        </header>
        <div class="card-body form-body">
          <FileProblems file={form.file} fileName={ANSWERS_FILE} />
          {rows.length === 0 ? (
            <EmptyState
              icon="note"
              title="No saved answers yet"
              compact
              actions={
                <button type="button" class="btn primary" onClick={add}>
                  <Icon name="plus" size={14} /> Add an answer
                </button>
              }
            >
              Keep answers to the questions application forms ask again and again, like your notice
              period or whether you need a visa. Assisted applying (M4) fills them in for you.
            </EmptyState>
          ) : (
            <>
              <p class="muted">
                Reused when you fill in application forms. Sensitive answers are never filled in
                without asking.
              </p>
              <ol class="answer-list">
                {rows.map((row, i) => {
                  const questionError = rowError(e, i, "question") ?? rowError(e, i, "id");
                  const answerError = rowError(e, i, "answer");
                  const tagsError = rowError(e, i, "tags");
                  const aliasesError = rowError(e, i, "aliases");
                  const kind = KINDS.find((k) => k.value === row.kind);
                  const aliasCount = row.aliases.split(/\r?\n/).filter((a) => a.trim()).length;
                  return (
                    <li key={row.key} class="answer-item">
                      <div class="answer-head">
                        <div class="field">
                          <label for={`answer-q-${row.key}`}>Question</label>
                          <input
                            id={`answer-q-${row.key}`}
                            class="input"
                            value={row.question}
                            placeholder="What is your notice period?"
                            aria-invalid={questionError ? "true" : undefined}
                            onInput={(ev) =>
                              setRow(i, { question: ev.currentTarget.value }, "question")
                            }
                          />
                          {questionError ? <span class="error">{questionError}</span> : null}
                        </div>
                        <button
                          type="button"
                          class="btn ghost icon"
                          aria-label={`Remove answer ${i + 1}`}
                          title="Remove answer"
                          onClick={() => remove(i)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                      <div class="field">
                        <label for={`answer-a-${row.key}`}>Answer</label>
                        <textarea
                          id={`answer-a-${row.key}`}
                          class="textarea answer-text"
                          rows={2}
                          value={row.answer}
                          placeholder={kind?.placeholder}
                          aria-invalid={answerError ? "true" : undefined}
                          onInput={(ev) => setRow(i, { answer: ev.currentTarget.value }, "answer")}
                        />
                        {answerError ? <span class="error">{answerError}</span> : null}
                      </div>
                      <div class="answer-meta">
                        <div class="field">
                          <label for={`answer-k-${row.key}`}>Type</label>
                          <select
                            id={`answer-k-${row.key}`}
                            class="select"
                            value={row.kind}
                            onChange={(ev) =>
                              setRow(i, { kind: ev.currentTarget.value as Kind }, "kind")
                            }
                          >
                            {KINDS.map((k) => (
                              <option key={k.value} value={k.value}>
                                {k.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div class="field">
                          <label for={`answer-t-${row.key}`}>Tags</label>
                          <input
                            id={`answer-t-${row.key}`}
                            class="input"
                            value={row.tags}
                            placeholder="availability, notice-period"
                            aria-invalid={tagsError ? "true" : undefined}
                            onInput={(ev) => setRow(i, { tags: ev.currentTarget.value }, "tags")}
                          />
                          {tagsError ? <span class="error">{tagsError}</span> : null}
                        </div>
                      </div>
                      <Check
                        label="Sensitive"
                        hint="Never filled in without asking"
                        checked={row.sensitive}
                        onChange={(on) => setRow(i, { sensitive: on }, "sensitive")}
                      />
                      <div class="answer-foot">
                        <details class="disclosure">
                          <summary>
                            Other phrasings{aliasCount > 0 ? ` (${aliasCount})` : ""}
                            {aliasesError ? <span class="error"> - {aliasesError}</span> : null}
                          </summary>
                          <div class="field">
                            <textarea
                              class="textarea"
                              rows={3}
                              aria-label="Other phrasings, one per line"
                              value={row.aliases}
                              placeholder="How much notice do you need to give?"
                              aria-invalid={aliasesError ? "true" : undefined}
                              onInput={(ev) =>
                                setRow(i, { aliases: ev.currentTarget.value }, "aliases")
                              }
                            />
                            <span class="hint">
                              One per line. Helps match the question when a form words it
                              differently.
                            </span>
                          </div>
                        </details>
                        {ids[i] ? (
                          <code class="answer-id" title={`Id in ${ANSWERS_FILE}`}>
                            {ids[i]}
                          </code>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div>
                <button type="button" class="btn ghost small" onClick={add}>
                  <Icon name="plus" size={12} /> Add an answer
                </button>
              </div>
            </>
          )}
        </div>
        <SaveBar form={form} fileName={ANSWERS_FILE} />
      </section>
    </form>
  );
}
