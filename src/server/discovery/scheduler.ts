import type { TaskRunner } from "../tasks.ts";
import type { DiscoveryService } from "./service.ts";

const CHECK_EVERY_MS = 60_000;

/**
 * Runs scheduled scans while Hirehound is open: every `schedule.every_hours` from sources/
 * portals.yaml, counted from the last scan. With the app closed, `hirehound scan` from an OS
 * scheduler (cron, Task Scheduler) does the same. The timer never keeps the process alive.
 */
export class ScanScheduler {
  readonly #discovery: DiscoveryService;
  readonly #tasks: TaskRunner;
  readonly #log: (message: string) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(deps: {
    discovery: DiscoveryService;
    tasks: TaskRunner;
    log: (message: string) => void;
  }) {
    this.#discovery = deps.discovery;
    this.#tasks = deps.tasks;
    this.#log = deps.log;
  }

  start(firstCheckMs = 15_000): void {
    this.#stopped = false;
    this.#plan(firstCheckMs);
  }

  #plan(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#tick(), delay);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    try {
      const { nextAt } = await this.#discovery.schedule();
      if (nextAt && Date.parse(nextAt) <= Date.now() && !this.#tasks.running("scan")) {
        this.#discovery.startScan("scheduled");
      }
    } catch (error) {
      this.#log(`Scheduled scan skipped: ${(error as Error).message}`);
    }
    this.#plan(CHECK_EVERY_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
