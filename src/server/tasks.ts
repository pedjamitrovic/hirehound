import { randomUUID } from "node:crypto";
import type { TaskInfo } from "../shared/schemas/api.ts";
import { localIsoDateTime } from "../shared/time.ts";
import type { AiProgress, Usage } from "./ai/types.ts";
import { HttpError } from "./http/router.ts";

export type TaskContext = {
  signal: AbortSignal;
  progress(message: string): void;
  /** Forward engine progress (tokens, retries) as readable progress lines. */
  aiProgress(progress: AiProgress): void;
  addUsage(usage: Usage): void;
};

type Listener = (task: TaskInfo) => void;

const KEEP_FINISHED = 20;

/**
 * Background jobs (AI tasks) that outlive the HTTP request that started them. Every state change
 * is broadcast so all open tabs show progress, and the result stays available for a while.
 */
export class TaskRunner {
  #tasks = new Map<string, TaskInfo>();
  #controllers = new Map<string, AbortController>();
  #listeners = new Set<Listener>();
  readonly #limit: number;
  #active = 0;
  #waiting: (() => void)[] = [];

  /** `concurrency`: how many tasks do work at once; the rest wait their turn. */
  constructor(options: { concurrency?: number } = {}) {
    this.#limit = Math.max(1, options.concurrency ?? 3);
  }

  async #acquire(signal: AbortSignal, progress: (message: string) => void): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active++;
      return;
    }
    progress("Waiting for other tasks to finish");
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", cancel);
        this.#active++;
        resolve();
      };
      const cancel = () => {
        this.#waiting = this.#waiting.filter((w) => w !== go);
        reject(new Error("Cancelled."));
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.#waiting.push(go);
    });
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(task: TaskInfo): void {
    this.#tasks.set(task.id, task);
    for (const listener of this.#listeners) listener(task);
  }

  list(): TaskInfo[] {
    return [...this.#tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): TaskInfo | undefined {
    return this.#tasks.get(id);
  }

  running(kind?: string): TaskInfo | undefined {
    return this.list().find((t) => t.state === "running" && (!kind || t.kind === kind));
  }

  cancel(id: string): boolean {
    const controller = this.#controllers.get(id);
    controller?.abort();
    return Boolean(controller);
  }

  /** The running task for a job, if any. */
  runningForJob(jobId: string): TaskInfo | undefined {
    return this.list().find((t) => t.state === "running" && t.jobId === jobId);
  }

  /**
   * Starts `work` in the background. Refuses a second running task of the same exclusive kind, and
   * a second task for the same job.
   */
  start(
    kind: string,
    label: string,
    work: (ctx: TaskContext) => Promise<unknown>,
    options: { exclusive?: boolean; jobId?: string } = {},
  ): TaskInfo {
    if (options.exclusive && this.running(kind)) {
      throw new HttpError(409, "task-running", "That is already running. Wait for it to finish.");
    }
    if (options.jobId && this.runningForJob(options.jobId)) {
      throw new HttpError(
        409,
        "job-busy",
        "Something is already running for this job. Wait for it to finish.",
      );
    }
    const controller = new AbortController();
    let task: TaskInfo = {
      id: randomUUID(),
      kind,
      label,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      state: "running",
      startedAt: localIsoDateTime(),
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    this.#controllers.set(task.id, controller);
    this.#emit(task);

    const update = (patch: Partial<TaskInfo>) => {
      task = { ...task, ...patch };
      this.#emit(task);
    };
    const ctx: TaskContext = {
      signal: controller.signal,
      progress: (message) => update({ progress: message }),
      aiProgress: (p) => {
        if (p.type === "started") update({ progress: `Thinking (${p.model})` });
        else if (p.type === "tokens")
          update({ progress: `Writing (about ${p.outputTokens.toLocaleString("en")} tokens)` });
        else update({ progress: `Retrying: ${p.reason}` });
      },
      addUsage: (usage) => {
        const current = task.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        update({
          usage: {
            inputTokens: current.inputTokens + usage.inputTokens,
            outputTokens: current.outputTokens + usage.outputTokens,
            costUsd:
              current.costUsd === null || usage.costUsd === null
                ? null
                : current.costUsd + usage.costUsd,
          },
        });
      },
    };

    void this.#acquire(controller.signal, ctx.progress)
      .then(async () => {
        try {
          return await work(ctx);
        } finally {
          this.#release();
        }
      })
      .then((result) =>
        update({ state: "done", finishedAt: localIsoDateTime(), result, progress: "Done" }),
      )
      .catch((error: unknown) =>
        update({
          state: "failed",
          finishedAt: localIsoDateTime(),
          error: controller.signal.aborted ? "Cancelled." : (error as Error).message,
        }),
      )
      .finally(() => {
        this.#controllers.delete(task.id);
        this.#prune();
      });
    return task;
  }

  #prune(): void {
    const finished = this.list().filter((t) => t.state !== "running");
    for (const task of finished.slice(KEEP_FINISHED)) this.#tasks.delete(task.id);
  }

  cancelAll(): void {
    for (const controller of this.#controllers.values()) controller.abort();
  }
}
