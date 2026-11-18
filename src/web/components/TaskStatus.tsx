import { useEffect, useRef, useState } from "preact/hooks";
import type { AiSettings, TaskInfo } from "../../shared/schemas/api.ts";
import { api, errorMessage } from "../api.ts";
import { runningTasks, tasks } from "../state/store.ts";
import { toast } from "../state/toasts.ts";
import { Icon } from "./Icon.tsx";
import { Link, Notice } from "./ui.tsx";

/** null while loading (or unknown), false when no engine can run, true otherwise. */
export function useAiReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    api.aiSettings().then(
      (s: AiSettings) => setReady(s.engine === "claude-code" || s.apiKey.present),
      () => setReady(null),
    );
  }, []);
  return ready;
}

/** Says why an AI action is disabled and where to fix it. */
export function AiReadiness(props: { ready: boolean | null }) {
  if (props.ready !== false) return null;
  return (
    <Notice kind="warning">
      This uses Claude. Add an Anthropic API key (or switch to your Claude Code login) in{" "}
      <Link href="/settings">Settings</Link> first.
    </Notice>
  );
}

export function formatCost(usage: TaskInfo["usage"]): string | null {
  if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) return null;
  const tokens = `${((usage.inputTokens + usage.outputTokens) / 1000).toFixed(1)}k tokens`;
  return usage.costUsd === null ? tokens : `${tokens}, about $${usage.costUsd.toFixed(2)}`;
}

/** The live state of one task, from the SSE-fed store. */
export function useTask(id: string | null): TaskInfo | null {
  return id ? (tasks.value.get(id) ?? null) : null;
}

/** Calls `onDone` / `onFailed` once when the task finishes. */
export function useTaskOutcome(
  task: TaskInfo | null,
  handlers: { onDone?: (task: TaskInfo) => void; onFailed?: (task: TaskInfo) => void },
): void {
  const seen = useRef<string | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!task || task.state === "running") return;
    const key = `${task.id}:${task.state}`;
    if (seen.current === key) return;
    seen.current = key;
    if (task.state === "done") latest.current.onDone?.(task);
    else latest.current.onFailed?.(task);
  }, [task?.id, task?.state]);
}

/** Progress, cost and outcome of one task, with a cancel button while it runs. */
export function TaskStatus(props: { task: TaskInfo }) {
  const { task } = props;
  const cost = formatCost(task.usage);
  if (task.state === "failed") {
    return (
      <Notice kind="danger">
        <strong>{task.label} failed.</strong> {task.error}
      </Notice>
    );
  }
  if (task.state === "done") {
    return (
      <Notice>
        <strong>{task.label}: done.</strong> {cost ? <span class="muted">{cost}</span> : null}
      </Notice>
    );
  }
  return (
    <div class="task-status" role="status">
      <span class="pulse" aria-hidden="true" />
      <div>
        <strong>{task.label}</strong>
        <div class="muted">
          {task.progress ?? "Starting"}
          {cost ? ` . ${cost}` : ""}
        </div>
      </div>
      <button
        type="button"
        class="btn small"
        onClick={() => api.cancelTask(task.id).catch((e) => toast(errorMessage(e), "error"))}
      >
        Cancel
      </button>
    </div>
  );
}

/** Top bar indicator: what is running in the background right now. */
export function TaskIndicator() {
  const running = runningTasks.value;
  if (running.length === 0) return null;
  const first = running[0] as TaskInfo;
  return (
    <span class="task-indicator" title={first.progress ?? first.label} role="status">
      <span class="pulse" aria-hidden="true" />
      <span class="truncate">
        {first.label}
        {running.length > 1 ? ` (+${running.length - 1})` : ""}
      </span>
      <Icon name="chevronRight" size={12} />
    </span>
  );
}
