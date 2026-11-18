import {
  type AiEngine,
  AiError,
  type AiRequest,
  type AiResult,
  type EngineHealth,
} from "./types.ts";

type Handler = (request: AiRequest<unknown>) => unknown;

/**
 * Test engine: answers each task with a canned handler, validates like a real engine and records
 * every request. Never touches the network.
 */
export class FakeEngine implements AiEngine {
  readonly id = "anthropic-api" as const;
  readonly requests: AiRequest<unknown>[] = [];
  readonly #handlers: Map<string, Handler[]>;

  /** Each task maps to one handler or a list used in order (for retry scenarios). */
  constructor(handlers: Record<string, Handler | Handler[]>) {
    this.#handlers = new Map(
      Object.entries(handlers).map(([task, h]) => [task, Array.isArray(h) ? [...h] : [h]]),
    );
  }

  async health(): Promise<EngineHealth> {
    return { ok: true, detail: "Fake engine" };
  }

  async run<T>(request: AiRequest<T>): Promise<AiResult<T>> {
    this.requests.push(request as AiRequest<unknown>);
    const queue = this.#handlers.get(request.task);
    if (!queue?.length) throw new Error(`FakeEngine: no handler for task ${request.task}`);
    const handler = queue.length > 1 ? (queue.shift() as Handler) : (queue[0] as Handler);
    const raw = handler(request as AiRequest<unknown>);
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AiError("invalid-output", parsed.error.issues.map((i) => i.message).join("; "));
    }
    return {
      output: parsed.data,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
      },
      engine: this.id,
      model: request.model,
      durationMs: 1,
    };
  }
}
