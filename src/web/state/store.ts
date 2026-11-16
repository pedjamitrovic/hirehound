import { batch, computed, signal } from "@preact/signals";
import type { JobSummary, ServerEvent, WorkspaceInfo } from "../../shared/schemas/api.ts";
import { isClosed } from "../../shared/states.ts";
import { api, errorMessage } from "../api.ts";

export const jobs = signal<ReadonlyMap<string, JobSummary>>(new Map());
export const workspace = signal<WorkspaceInfo | null>(null);
export const connection = signal<"connecting" | "live" | "offline">("connecting");
export const loaded = signal(false);
export const loadError = signal<string | null>(null);

/** Bumped per job whenever the server reports a change, so open dossiers refetch. */
export const jobRevisions = signal<ReadonlyMap<string, number>>(new Map());

export const jobList = computed(() =>
  [...jobs.value.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);

export const activeJobs = computed(() => jobList.value.filter((j) => !isClosed(j.state)));

function bump(id: string): void {
  const next = new Map(jobRevisions.value);
  next.set(id, (next.get(id) ?? 0) + 1);
  jobRevisions.value = next;
}

/** Apply a summary the client already has (e.g. from a mutation response) immediately. */
export function upsertJob(job: JobSummary): void {
  const next = new Map(jobs.value);
  next.set(job.id, job);
  batch(() => {
    jobs.value = next;
    bump(job.id);
  });
}

function handle(event: ServerEvent): void {
  switch (event.type) {
    case "job-upsert":
      upsertJob(event.job);
      break;
    case "job-remove": {
      const next = new Map(jobs.value);
      next.delete(event.id);
      batch(() => {
        jobs.value = next;
        bump(event.id);
      });
      break;
    }
    case "workspace":
      workspace.value = event.info;
      break;
    case "hello":
      break;
  }
}

export async function refresh(): Promise<void> {
  try {
    const [info, list] = await Promise.all([api.workspace(), api.jobs()]);
    batch(() => {
      workspace.value = info;
      jobs.value = new Map(list.map((j) => [j.id, j]));
      loaded.value = true;
      loadError.value = null;
    });
  } catch (error) {
    loadError.value = errorMessage(error);
  }
}

let source: EventSource | null = null;

/** Initial load plus live updates. Every (re)connect reloads everything, so no change is missed. */
export function startSync(): void {
  if (source) return;
  source = new EventSource("/api/events");
  source.onopen = () => {
    connection.value = "live";
    void refresh();
  };
  source.onerror = () => {
    connection.value = "offline";
  };
  source.onmessage = (message) => {
    try {
      handle(JSON.parse(message.data) as ServerEvent);
    } catch {
      // Ignore malformed events; the next reconnect reloads everything anyway.
    }
  };
}
