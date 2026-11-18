import { signal } from "@preact/signals";
import type { JobSummary } from "../../shared/schemas/api.ts";
import type { JobState } from "../../shared/schemas/status.ts";
import { STATE_LABELS, type TransitionOption } from "../../shared/states.ts";
import { api, errorMessage } from "../api.ts";
import { upsertJob } from "./store.ts";
import { toast } from "./toasts.ts";

/** Global dialogs, opened from anywhere (hotkeys, buttons, drag and drop). */
export const addJobOpen = signal(false);

export type MoveRequest = {
  jobs: JobSummary[];
  /** Skip the picker and go straight to this move (e.g. after a drop on a column). */
  preset?: { to: JobState; method?: "external" };
};

export const moveRequest = signal<MoveRequest | null>(null);

export function openMove(jobs: JobSummary[], preset?: MoveRequest["preset"]): void {
  if (jobs.length === 0) return;
  moveRequest.value = { jobs, ...(preset ? { preset } : {}) };
}

export function optionLabel(option: Pick<TransitionOption, "to" | "kind">): string {
  if (option.kind === "external") return "Applied externally";
  if (option.kind === "reopen") return `Reopen as ${STATE_LABELS[option.to]}`;
  return STATE_LABELS[option.to];
}

/** The option for moving a job to `to`, preferring a real edge over "applied externally". */
export function optionFor(job: JobSummary, to: JobState): TransitionOption | undefined {
  const options = job.transitions.filter((o) => o.to === to);
  return (
    options.find((o) => o.kind !== "external" && o.allowed) ??
    options.find((o) => o.allowed) ??
    options[0]
  );
}

/** Moves one job. Returns true on success; failures are shown as toasts. */
export async function moveJob(
  job: JobSummary,
  option: Pick<TransitionOption, "to" | "method">,
  reason?: string,
): Promise<boolean> {
  try {
    const detail = await api.transition(job.id, {
      to: option.to,
      ...(option.method ? { method: option.method } : {}),
      ...(reason ? { reason } : {}),
    });
    upsertJob(detail.summary);
    toast(`${job.company}: moved to ${STATE_LABELS[option.to]}`, "success");
    return true;
  } catch (error) {
    toast(errorMessage(error), "error");
    return false;
  }
}

export async function moveJobs(
  jobs: JobSummary[],
  option: Pick<TransitionOption, "to" | "method">,
  reason?: string,
): Promise<boolean> {
  if (jobs.length === 1 && jobs[0]) return moveJob(jobs[0], option, reason);
  try {
    const { results } = await api.bulkTransition({
      ids: jobs.map((j) => j.id),
      to: option.to,
      ...(option.method ? { method: option.method } : {}),
      ...(reason ? { reason } : {}),
    });
    const failed = results.filter((r) => !r.ok);
    const moved = results.length - failed.length;
    if (failed.length === 0) toast(`Moved ${moved} jobs to ${STATE_LABELS[option.to]}`, "success");
    else {
      toast(
        `Moved ${moved} of ${results.length}. Not moved: ${failed[0]?.message ?? "unknown error"}`,
        "error",
      );
    }
    return failed.length === 0;
  } catch (error) {
    toast(errorMessage(error), "error");
    return false;
  }
}
