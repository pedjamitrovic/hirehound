import type { z } from "zod";

export type EngineId = "anthropic-api" | "claude-code";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Attachment =
  | { kind: "text"; name: string; text: string }
  | { kind: "pdf"; name: string; data: Uint8Array };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Reported by Claude Code; estimated from the price table for the API. null when unknown. */
  costUsd: number | null;
};

export type AiProgress =
  | { type: "started"; model: string }
  | { type: "tokens"; outputTokens: number }
  | { type: "retry"; attempt: number; reason: string };

export type AiRequest<T> = {
  /** Task name, for logs and usage attribution: "draft-bank", "draft-base", ... */
  task: string;
  system: string;
  input: string;
  attachments?: Attachment[];
  /** Output contract. Engines derive JSON Schema from it and validate the result with it. */
  schema: z.ZodType<T>;
  model: string;
  effort?: Effort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onProgress?: (progress: AiProgress) => void;
};

export type AiResult<T> = {
  output: T;
  usage: Usage;
  engine: EngineId;
  /** The model that actually served the request. */
  model: string;
  durationMs: number;
};

export type EngineHealth =
  | { ok: true; detail: string }
  | {
      ok: false;
      reason: "missing-key" | "not-installed" | "not-logged-in" | "invalid-key" | "error";
      detail: string;
    };

export interface AiEngine {
  readonly id: EngineId;
  health(model: string): Promise<EngineHealth>;
  run<T>(request: AiRequest<T>): Promise<AiResult<T>>;
}

export type AiErrorCode =
  | "auth"
  | "rate-limit"
  | "overloaded"
  | "refusal"
  | "max-tokens"
  | "invalid-output"
  | "invalid-request"
  | "network"
  | "aborted"
  | "unavailable";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  /** Raw model output when the failure is about the output (for diagnostics, never logged). */
  readonly output: string | undefined;

  constructor(code: AiErrorCode, message: string, retryable = false, output?: string) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.output = output;
  }
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}
