import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import type { Inline } from "../../../shared/cv/types.ts";
import type { EvidenceInfo, TaskInfo } from "../../../shared/schemas/api.ts";
import { TaskStatus } from "../../components/TaskStatus.tsx";
import { tasks } from "../../state/store.ts";

/** The newest task for a job (running or finished in this session), from the SSE-fed store. */
export function useJobTask(jobId: string): TaskInfo | null {
  let latest: TaskInfo | null = null;
  for (const task of tasks.value.values()) {
    if (task.jobId !== jobId) continue;
    if (!latest || task.startedAt > latest.startedAt) latest = task;
  }
  return latest;
}

/** Progress while a job task runs, and the error if it failed. Done tasks speak through results. */
export function JobTaskStatus(props: { task: TaskInfo | null }) {
  const { task } = props;
  if (!task || task.state === "done") return null;
  return <TaskStatus task={task} />;
}

/** CV inline formatting as Preact nodes (never HTML strings). */
export function InlineText(props: { nodes: readonly Inline[] }) {
  return (
    <>
      {props.nodes.map((node, i) => {
        if (node.t === "text") return node.v;
        if (node.t === "strong") {
          return (
            <strong key={i}>
              <InlineText nodes={node.c} />
            </strong>
          );
        }
        if (node.t === "em") {
          return (
            <em key={i}>
              <InlineText nodes={node.c} />
            </em>
          );
        }
        return (
          <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
            <InlineText nodes={node.c} />
          </a>
        );
      })}
    </>
  );
}

/** An experience-bank id; hovering or focusing it shows the entry the claim rests on. */
export function EvidenceChip(props: { id: string; info: EvidenceInfo | undefined }) {
  const { id, info } = props;
  const tipId = useId();
  const missing = !info || info.kind === null;
  return (
    <span class="ev">
      <button
        type="button"
        class={`chip evidence${missing ? " missing" : info.confirmed ? "" : " unconfirmed"}`}
        aria-describedby={tipId}
      >
        {id}
      </button>
      <span class="ev-tip" role="tooltip" id={tipId}>
        <strong>{info?.label ?? "Not in the experience bank"}</strong>
        {info?.detail ? <span class="ev-detail">{info.detail}</span> : null}
        {info && !info.confirmed && !missing ? (
          <span class="ev-warning">Not confirmed in the experience bank.</span>
        ) : null}
      </span>
    </span>
  );
}

export function EvidenceChips(props: {
  ids: readonly string[];
  evidence: Record<string, EvidenceInfo>;
  children?: ComponentChildren;
}) {
  return (
    <span class="ev-list">
      {props.ids.map((id) => (
        <EvidenceChip key={id} id={id} info={props.evidence[id]} />
      ))}
      {props.children}
    </span>
  );
}

export const VERDICT_LABELS = {
  supported: "Supported",
  weakened: "Weakened",
  unsupported: "Unsupported",
} as const;

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
