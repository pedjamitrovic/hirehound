import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { entryLabel, indexBank } from "../../shared/bank.ts";
import type { ImportInfo } from "../../shared/schemas/api.ts";
import type { BankFile } from "../../shared/schemas/bank.ts";
import type { OnboardingFile } from "../../shared/schemas/onboarding.ts";
import { api, type BankOpInput, errorMessage } from "../api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import {
  AiReadiness,
  TaskStatus,
  useAiReady,
  useTask,
  useTaskOutcome,
} from "../components/TaskStatus.tsx";
import { EmptyState, Notice } from "../components/ui.tsx";
import { navigate, searchParams, setSearchParams } from "../router.ts";
import { profileRevision, workspace } from "../state/store.ts";
import { toast } from "../state/toasts.ts";
import { BankEditor } from "./profile/BankEditor.tsx";
import { BaseList } from "./profile/Bases.tsx";
import { ContactForm } from "./profile/ContactForm.tsx";
import { PreferencesForm } from "./profile/PreferencesForm.tsx";

type Step = "files" | "questions" | "review" | "contact" | "bases" | "preferences";

const STEPS: { id: Step; label: string }[] = [
  { id: "files", label: "Your files" },
  { id: "questions", label: "Questions" },
  { id: "review", label: "Review" },
  { id: "contact", label: "Contact" },
  { id: "bases", label: "Base CVs" },
  { id: "preferences", label: "Preferences" },
];

/** "1 answer", "3 answers". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatSize(bytes: number): string {
  return bytes > 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

const ORIGIN_LABEL: Record<string, string> = {
  md: "Markdown",
  txt: "Text",
  docx: "Word",
  linkedin: "LinkedIn export",
  pdf: "PDF",
};

function FilesStep(props: { onDrafted: () => void }) {
  const [imports, setImports] = useState<ImportInfo[] | null>(null);
  const aiReady = useAiReady();
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const task = useTask(taskId);
  useTaskOutcome(task, {
    onDone: (t) => {
      const result = t.result as { entries: number; questions: number } | undefined;
      toast(
        `Drafted ${result?.entries ?? 0} entries and ${result?.questions ?? 0} questions`,
        "success",
      );
      props.onDrafted();
    },
  });

  const load = () => api.imports().then(setImports, (e) => toast(errorMessage(e), "error"));
  useEffect(() => {
    void load();
  }, []);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    setUploading(list.length);
    for (const file of list) {
      try {
        await api.uploadImport(file);
      } catch (e) {
        toast(`${file.name}: ${errorMessage(e)}`, "error");
      }
      setUploading((n) => n - 1);
    }
    await load();
  };

  const usable = (imports ?? []).filter((i) => !i.error);
  const running = task?.state === "running";

  return (
    <div class="onboarding-step">
      <h2>Start from what you already have</h2>
      <p class="secondary">
        Add your existing CVs, a LinkedIn data export (.zip), performance reviews or notes. Claude
        drafts your experience bank from them. Nothing is used in a CV until you have reviewed it.
      </p>
      <label
        class="dropzone"
        data-dragging={dragging ? "true" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
        }}
      >
        <Icon name="folder" size={18} />
        <span>
          <strong>Drop files here</strong> or <span class="link-like">choose files</span>
        </span>
        <span class="muted">
          .pdf, .docx, .md, .txt, or a LinkedIn export .zip (up to 25 MB each)
        </span>
        <input
          ref={input}
          type="file"
          multiple
          accept=".pdf,.docx,.md,.markdown,.txt,.zip"
          class="visually-hidden"
          onChange={(e) => {
            if (e.currentTarget.files?.length) void upload(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </label>
      {uploading > 0 ? <p class="muted">Uploading {uploading} file(s)...</p> : null}
      {imports && imports.length > 0 ? (
        <ul class="list card">
          {imports.map((i) => (
            <li key={i.name} class="list-row">
              <Icon name={i.error ? "alert" : "text"} size={14} />
              <span class="truncate">{i.name}</span>
              <span class="meta">
                {i.error ? (
                  <span class="badge danger" title={i.error}>
                    Cannot read
                  </span>
                ) : (
                  <span class="badge">{ORIGIN_LABEL[i.origin] ?? i.origin}</span>
                )}
                <span>
                  {i.chars ? `${i.chars.toLocaleString()} characters` : formatSize(i.size)}
                </span>
                <button
                  type="button"
                  class="btn ghost icon small"
                  aria-label={`Remove ${i.name}`}
                  onClick={async () => {
                    await api.deleteImport(i.name).catch((e) => toast(errorMessage(e), "error"));
                    await load();
                  }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p class="muted">
        Files are copied into profile/imports in your workspace. They go only to the AI provider you
        configured.
      </p>
      <AiReadiness ready={aiReady} />
      {task ? <TaskStatus task={task} /> : null}
      <div class="step-actions">
        <button
          type="button"
          class="btn primary"
          disabled={usable.length === 0 || running || aiReady === false}
          onClick={async () => {
            try {
              setTaskId((await api.draftBank()).id);
            } catch (e) {
              toast(errorMessage(e), "error");
            }
          }}
        >
          <Icon name="today" size={14} /> Draft my experience bank
        </button>
        {workspace.value?.profile.bank.entries ? (
          <button type="button" class="btn ghost" onClick={props.onDrafted}>
            Skip, my bank already has entries
          </button>
        ) : null}
      </div>
    </div>
  );
}

type Proposal = {
  ops: BankOpInput[];
  changes: {
    id: string | null;
    kind: string;
    parent?: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    questions: string[];
  }[];
  bankSha256: string | null;
  questionIds: string[];
  unused: { question: string; reason: string }[];
};

const show = (v: unknown) =>
  Array.isArray(v) ? v.join("; ") : v === undefined || v === null ? "" : String(v);

function ChangeView(props: { change: Proposal["changes"][number] }) {
  const { before, after } = props.change;
  const keys = Object.keys(after).filter(
    (k) => !["confirmed", "source", "id"].includes(k) && show(after[k]) !== show(before?.[k]),
  );
  return (
    <li class="change">
      <div class="change-head">
        <code class="bank-id">{props.change.id ?? `new ${props.change.kind}`}</code>
        {props.change.parent ? <span class="muted">under {props.change.parent}</span> : null}
        <span class="muted">from {props.change.questions.join(", ")}</span>
      </div>
      {keys.map((k) => (
        <div key={k} class="change-field">
          <span class="change-key">{k}</span>
          {before && show(before[k]) ? <del>{show(before[k])}</del> : null}
          <ins>{show(after[k])}</ins>
        </div>
      ))}
    </li>
  );
}

function QuestionsStep(props: { onNext: () => void }) {
  const [file, setFile] = useState<OnboardingFile | null>(null);
  const [bank, setBank] = useState<BankFile | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [taskId, setTaskId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [applying, setApplying] = useState(false);
  const task = useTask(taskId);
  useTaskOutcome(task, { onDone: (t) => setProposal(t.result as Proposal) });

  const load = async () => {
    const [onboarding, bankFile] = await Promise.all([api.onboarding(), api.bank()]);
    setFile(onboarding);
    setBank(bankFile.value);
    setDrafts(Object.fromEntries(onboarding.questions.map((q) => [q.id, q.answer ?? ""])));
  };
  useEffect(() => {
    load().catch((e) => toast(errorMessage(e), "error"));
  }, []);

  const index = useMemo(() => (bank ? indexBank(bank) : new Map()), [bank]);
  const open = file?.questions.filter((q) => q.status === "open") ?? [];
  const answered = open.filter((q) => (drafts[q.id] ?? "").trim());
  const skipped = file?.questions.filter((q) => q.status === "skipped") ?? [];
  const aiReady = useAiReady();

  const saveAnswer = (id: string) =>
    api
      .saveQuestionAnswers([{ id, answer: drafts[id] ?? "" }])
      .then(setFile)
      .catch((e) => toast(errorMessage(e), "error"));

  if (!file) return <div class="empty compact muted">Loading questions...</div>;

  return (
    <div class="onboarding-step">
      <h2>Fill the gaps</h2>
      <p class="secondary">
        Answers make your CVs stronger: exact dates, numbers and scope. Answer what you know, skip
        the rest. Claude turns your answers into edits you review before anything is saved.
      </p>
      {open.length === 0 && !proposal ? (
        <EmptyState icon="check" title="No open questions" compact>
          You can always add details in the experience bank directly.
        </EmptyState>
      ) : null}
      {!proposal ? (
        <ol class="questions">
          {open.map((q) => {
            const about = q.entry ? index.get(q.entry) : undefined;
            return (
              <li key={q.id} class="question card">
                <div class="question-head">
                  <strong>{q.question}</strong>
                  <button
                    type="button"
                    class="btn ghost small"
                    onClick={() =>
                      api
                        .saveQuestionAnswers([{ id: q.id, status: "skipped" }])
                        .then(setFile)
                        .catch((e) => toast(errorMessage(e), "error"))
                    }
                  >
                    Skip
                  </button>
                </div>
                {about ? (
                  <div class="muted">
                    About <code class="bank-id">{q.entry}</code> {entryLabel(about)}
                  </div>
                ) : null}
                {q.why ? <div class="muted">{q.why}</div> : null}
                <textarea
                  class="textarea"
                  rows={2}
                  placeholder="Your answer"
                  value={drafts[q.id] ?? ""}
                  onInput={(e) => setDrafts({ ...drafts, [q.id]: e.currentTarget.value })}
                  onBlur={() => {
                    if ((drafts[q.id] ?? "") !== (q.answer ?? "")) void saveAnswer(q.id);
                  }}
                />
              </li>
            );
          })}
        </ol>
      ) : (
        <div class="proposal">
          <h3>Proposed edits</h3>
          {proposal.changes.length === 0 ? (
            <p class="muted">The answers did not contain facts to add.</p>
          ) : (
            <ul class="changes">
              {proposal.changes.map((c, i) => (
                <ChangeView key={`${c.id}-${i}`} change={c} />
              ))}
            </ul>
          )}
          {proposal.unused.length ? (
            <Notice>
              Not used: {proposal.unused.map((u) => `${u.question} (${u.reason})`).join("; ")}
            </Notice>
          ) : null}
          <div class="step-actions">
            <button
              type="button"
              class="btn primary"
              disabled={applying || proposal.ops.length === 0}
              onClick={async () => {
                setApplying(true);
                try {
                  await api.bankOps(proposal.ops, proposal.bankSha256);
                  await api.resolveQuestions(proposal.questionIds, "applied");
                  toast("Edits applied. Review them in the next step.", "success");
                  setProposal(null);
                  setTaskId(null);
                  await load();
                } catch (e) {
                  toast(errorMessage(e), "error");
                } finally {
                  setApplying(false);
                }
              }}
            >
              Apply {plural(proposal.ops.length, "edit")}
            </button>
            <button type="button" class="btn" onClick={() => setProposal(null)}>
              Back to answers
            </button>
          </div>
        </div>
      )}
      {skipped.length > 0 && !proposal ? (
        <p class="muted">
          {plural(skipped.length, "question")} skipped.{" "}
          <button
            type="button"
            class="link-button link-like"
            onClick={() =>
              api
                .resolveQuestions(
                  skipped.map((q) => q.id),
                  "open",
                )
                .then(setFile)
                .catch((e) => toast(errorMessage(e), "error"))
            }
          >
            Bring them back
          </button>
        </p>
      ) : null}
      {!proposal && answered.length > 0 ? <AiReadiness ready={aiReady} /> : null}
      {task && !proposal ? <TaskStatus task={task} /> : null}
      {!proposal ? (
        <div class="step-actions">
          <button
            type="button"
            class="btn primary"
            disabled={answered.length === 0 || task?.state === "running" || aiReady === false}
            onClick={async () => {
              try {
                await api.saveQuestionAnswers(
                  answered.map((q) => ({ id: q.id, answer: drafts[q.id] ?? "" })),
                );
                setTaskId((await api.proposeAnswers()).id);
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            }}
          >
            Turn {answered.length ? plural(answered.length, "answer") : "answers"} into edits
          </button>
          <button type="button" class="btn ghost" onClick={props.onNext}>
            Continue
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function OnboardingScreen(props: ScreenProps) {
  const step = (searchParams.value.get("step") as Step | null) ?? "files";
  const go = (next: Step) => setSearchParams({ step: next });
  const info = workspace.value;
  const [suggestion, setSuggestion] = useState<OnboardingFile["contact_suggestion"] | null>(null);
  const revision = profileRevision.value;
  useEffect(() => {
    api.onboarding().then(
      (f) => setSuggestion(f.contact_suggestion ?? null),
      () => {},
    );
  }, [revision]);

  const done: Record<Step, boolean> = {
    files: (info?.profile.bank.entries ?? 0) > 0,
    questions: false,
    review:
      (info?.profile.bank.entries ?? 0) > 0 &&
      info?.profile.bank.confirmed === info?.profile.bank.entries,
    contact: info?.profile.contact === "ok",
    bases: (info?.profile.bases.length ?? 0) >= 2,
    preferences: info?.profile.preferences === "ok",
  };
  const index = STEPS.findIndex((s) => s.id === step);
  const next = () => {
    const following = STEPS[index + 1];
    if (following) go(following.id);
    else navigate("/profile");
  };

  return (
    <>
      {props.frame("Set up your profile")}
      <div class="content">
        <div class="page onboarding">
          <ol class="wizard-steps">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                aria-current={s.id === step ? "step" : undefined}
                data-done={done[s.id] ? "true" : undefined}
              >
                <button type="button" onClick={() => go(s.id)}>
                  <span class="wizard-number">
                    {done[s.id] ? <Icon name="check" size={12} /> : i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
          {step === "files" ? <FilesStep onDrafted={() => go("questions")} /> : null}
          {step === "questions" ? <QuestionsStep onNext={next} /> : null}
          {step === "review" ? (
            <div class="onboarding-step">
              <h2>Review your experience bank</h2>
              <p class="secondary">
                Read each entry and tick it when it is true and accurate. Edit anything that is off.
                CVs only ever use confirmed entries.
              </p>
              <BankEditor initialFilter="review" />
              <div class="step-actions">
                <button type="button" class="btn primary" onClick={next}>
                  Continue
                </button>
              </div>
            </div>
          ) : null}
          {step === "contact" ? (
            <div class="onboarding-step">
              <h2>Contact details</h2>
              <p class="secondary">These go in the header of every CV.</p>
              <ContactForm suggestion={suggestion} onSaved={next} />
            </div>
          ) : null}
          {step === "bases" ? (
            <div class="onboarding-step">
              <h2>Base CVs</h2>
              <p class="secondary">
                Create one base CV per career track, for example management and senior individual
                contributor. Each is written only from confirmed entries, and every line cites them.
              </p>
              <BaseList />
              <div class="step-actions">
                <button type="button" class="btn primary" onClick={next}>
                  Continue
                </button>
              </div>
            </div>
          ) : null}
          {step === "preferences" ? (
            <div class="onboarding-step">
              <h2>What you are looking for</h2>
              <p class="secondary">Used to evaluate jobs and flag deal-breakers.</p>
              <PreferencesForm onSaved={() => navigate("/profile")} />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
