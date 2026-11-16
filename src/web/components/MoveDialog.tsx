import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JobSummary } from "../../shared/schemas/api.ts";
import type { JobState } from "../../shared/schemas/status.ts";
import { requiresReason, STATE_LABELS } from "../../shared/states.ts";
import { type MoveRequest, moveJobs, optionLabel } from "../state/actions.ts";
import { Dialog } from "./Dialog.tsx";
import { Kbd } from "./ui.tsx";

type Choice = {
  key: string;
  to: JobState;
  method?: "external";
  label: string;
  allowed: boolean;
  message?: string;
  needsReason: boolean;
  /** For bulk moves: how many of the selected jobs can make this move. */
  count: number;
};

/** Options valid for every job (one job), or the union with counts (bulk). */
function choicesFor(jobs: JobSummary[]): Choice[] {
  const byKey = new Map<string, Choice>();
  for (const job of jobs) {
    for (const option of job.transitions) {
      const key = `${option.to}:${option.method ?? ""}`;
      const existing = byKey.get(key);
      if (existing) {
        if (option.allowed) existing.count += 1;
        existing.allowed ||= option.allowed;
        continue;
      }
      byKey.set(key, {
        key,
        to: option.to,
        ...(option.method ? { method: option.method } : {}),
        label: jobs.length > 1 && option.kind === "reopen" ? "Reopen" : optionLabel(option),
        allowed: option.allowed,
        ...(option.message ? { message: option.message } : {}),
        needsReason: option.needsReason,
        count: option.allowed ? 1 : 0,
      });
    }
  }
  return [...byKey.values()];
}

const REASON_COPY: Partial<Record<JobState, { title: string; hint: string }>> = {
  skipped: {
    title: "Why skip it?",
    hint: "Skip reasons feed calibration: later, Hirehound suggests preference tweaks from them.",
  },
  withdrawn: { title: "Why are you withdrawing?", hint: "Kept in the job's timeline." },
};

const EXTERNAL_COPY = {
  title: "Where and when did you apply?",
  hint: "For applications made outside Hirehound. They are tracked, but have no approved PDF on record.",
};

export function MoveDialog(props: { request: MoveRequest; onClose: () => void }) {
  const { jobs, preset } = props.request;
  const choices = useMemo(() => choicesFor(jobs), [jobs]);
  const presetChoice = preset
    ? choices.find((c) => c.to === preset.to && (c.method ?? undefined) === preset.method)
    : undefined;
  const [picked, setPicked] = useState<Choice | null>(
    presetChoice?.needsReason ? presetChoice : null,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);

  const title =
    jobs.length === 1 && jobs[0]
      ? `Move ${jobs[0].company}: ${jobs[0].title}`
      : `Move ${jobs.length} jobs`;

  const run = async (choice: Choice, text?: string) => {
    setBusy(true);
    const ok = await moveJobs(
      jobs,
      { to: choice.to, ...(choice.method ? { method: choice.method } : {}) },
      text,
    );
    setBusy(false);
    if (ok || jobs.length > 1) props.onClose();
  };

  const choose = (choice: Choice) => {
    if (!choice.allowed || busy) return;
    if (choice.needsReason || requiresReason(choice.to, choice.method)) setPicked(choice);
    else void run(choice);
  };

  useEffect(() => {
    if (picked) reasonInput.current?.focus();
    else list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [picked]);

  if (picked) {
    const copy = picked.method === "external" ? EXTERNAL_COPY : REASON_COPY[picked.to];
    const submit = () => {
      if (reason.trim()) void run(picked, reason.trim());
    };
    return (
      <Dialog
        title={`${title} to ${picked.label}`}
        onClose={props.onClose}
        onSubmit={submit}
        footer={
          <>
            {presetChoice ? null : (
              <button type="button" class="btn ghost" onClick={() => setPicked(null)}>
                Back
              </button>
            )}
            <span class="spacer" />
            <button type="button" class="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="button"
              class="btn primary"
              disabled={!reason.trim() || busy}
              onClick={submit}
            >
              {picked.label} <Kbd keys="mod+enter" />
            </button>
          </>
        }
      >
        <div class="field">
          <label for="move-reason">{copy?.title ?? "Reason"}</label>
          <textarea
            id="move-reason"
            ref={reasonInput}
            class="textarea"
            style={{ minHeight: "88px" }}
            value={reason}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
          {copy?.hint ? <span class="hint">{copy.hint}</span> : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={props.onClose}>
      {choices.length === 0 ? (
        <p class="muted">This job is in a final state and cannot be moved.</p>
      ) : (
        <div
          ref={list}
          class="menu"
          style={{ boxShadow: "none", border: 0, padding: 0 }}
          role="menu"
          tabIndex={-1}
          onKeyDown={(e) => {
            const buttons = [
              ...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "j") {
              e.preventDefault();
              buttons[(index + 1) % buttons.length]?.focus();
            } else if (e.key === "ArrowUp" || e.key === "k") {
              e.preventDefault();
              buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
            } else if (/^[1-9]$/.test(e.key)) {
              const choice = choices.filter((c) => c.allowed)[Number(e.key) - 1];
              if (choice) {
                e.preventDefault();
                choose(choice);
              }
            }
          }}
        >
          {choices.map((choice) => {
            const number = choices.filter((c) => c.allowed).indexOf(choice) + 1;
            return (
              <button
                type="button"
                role="menuitem"
                key={choice.key}
                disabled={!choice.allowed || busy}
                title={choice.message}
                onClick={() => choose(choice)}
                data-state={choice.to}
              >
                <span class="state-dot" />
                <span>
                  {choice.label}
                  {!choice.allowed && choice.message ? (
                    <span class="muted" style={{ display: "block", fontSize: "var(--text-xs)" }}>
                      {choice.message}
                    </span>
                  ) : null}
                </span>
                <span class="hint">
                  {jobs.length > 1 && choice.allowed ? `${choice.count} of ${jobs.length}` : null}
                  {choice.allowed && number > 0 && number < 10 ? <kbd>{number}</kbd> : null}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {jobs.length === 1 && jobs[0] ? (
        <p class="muted" style={{ fontSize: "var(--text-xs)" }}>
          Currently {STATE_LABELS[jobs[0].state]}.
        </p>
      ) : null}
    </Dialog>
  );
}
