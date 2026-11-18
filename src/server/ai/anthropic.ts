import { setTimeout as sleep } from "node:timers/promises";
import { toOutputSchema } from "./json-schema.ts";
import { estimateCost } from "./pricing.ts";
import {
  type AiEngine,
  AiError,
  type AiRequest,
  type AiResult,
  type EngineHealth,
  type Usage,
} from "./types.ts";

export const ANTHROPIC_VERSION = "2026-10-21";
/** Server-side fallback: a refusal by a safety classifier is retried on a suitable model. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

type Options = {
  apiKey: () => string | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Delay between retries; tests set this to 0. */
  retryDelayMs?: number;
};

/** The subset of Messages API stream events we read. */
type StreamEvent = {
  type: string;
  index: number;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  content_block?: { type?: string };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
};

type StreamState = {
  model: string;
  text: string;
  blockTypes: Map<number, string>;
  stopReason: string | null;
  usage: Omit<Usage, "costUsd">;
};

function errorFromStatus(status: number, message: string, retryAfter: number | null): AiError {
  if (status === 401)
    return new AiError("auth", "The Anthropic API key was rejected. Check it in Settings.");
  if (status === 403) return new AiError("auth", `The API key may not use this model: ${message}`);
  if (status === 404) return new AiError("unavailable", `Model or endpoint not found: ${message}`);
  if (status === 413)
    return new AiError("invalid-request", "The request is too large (files or text).");
  if (status === 429) {
    const wait = retryAfter ? ` Try again in ${retryAfter}s.` : "";
    return new AiError("rate-limit", `Rate limited by the Anthropic API.${wait}`, true);
  }
  if (status === 529 || status >= 500) {
    return new AiError("overloaded", `The Anthropic API is busy (${status}). Retrying.`, true);
  }
  return new AiError("invalid-request", `The Anthropic API rejected the request: ${message}`);
}

/** Splits an SSE byte stream into { event, data } records. */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join("\n") };
      end = buffer.indexOf("\n\n");
    }
  }
}

/** Direct Messages API over fetch: zero dependencies, streaming, structured outputs. */
export class AnthropicApiEngine implements AiEngine {
  readonly id = "anthropic-api" as const;
  readonly #apiKey: () => string | null;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #retryDelayMs: number;

  constructor(options: Options) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#retryDelayMs = options.retryDelayMs ?? 2000;
  }

  #headers(key: string): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }

  async health(model: string): Promise<EngineHealth> {
    const key = this.#apiKey();
    if (!key) {
      return {
        ok: false,
        reason: "missing-key",
        detail: "No API key. Set ANTHROPIC_API_KEY or save a key in Settings.",
      };
    }
    try {
      // Looking up the model checks the key without spending tokens.
      const res = await this.#fetch(`${this.#baseUrl}/v1/models/${encodeURIComponent(model)}`, {
        headers: this.#headers(key),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return { ok: true, detail: `API key works; ${model} is available.` };
      if (res.status === 401)
        return { ok: false, reason: "invalid-key", detail: "The API key was rejected." };
      if (res.status === 404)
        return { ok: false, reason: "error", detail: `Model ${model} was not found.` };
      return { ok: false, reason: "error", detail: `The API answered ${res.status}.` };
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        detail: `Cannot reach the Anthropic API: ${(error as Error).message}`,
      };
    }
  }

  #body<T>(request: AiRequest<T>): string {
    const content: unknown[] = [];
    for (const attachment of request.attachments ?? []) {
      if (attachment.kind === "pdf") {
        content.push({
          type: "document",
          title: attachment.name,
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from(attachment.data).toString("base64"),
          },
        });
      } else {
        content.push({
          type: "document",
          title: attachment.name,
          source: { type: "text", media_type: "text/plain", data: attachment.text },
        });
      }
    }
    content.push({ type: "text", text: request.input });
    return JSON.stringify({
      model: request.model,
      max_tokens: request.maxOutputTokens ?? 32_000,
      stream: true,
      system: request.system,
      messages: [{ role: "user", content }],
      output_config: {
        format: { type: "json_schema", schema: toOutputSchema(request.schema) },
        effort: request.effort ?? "high",
      },
      fallbacks: "default",
    });
  }

  async #attempt<T>(
    request: AiRequest<T>,
    key: string,
  ): Promise<{ text: string; state: StreamState }> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
        method: "POST",
        headers: { ...this.#headers(key), "anthropic-beta": FALLBACK_BETA },
        body: this.#body(request),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new AiError("aborted", "Cancelled.");
      throw new AiError(
        "network",
        `Cannot reach the Anthropic API: ${(error as Error).message}`,
        true,
      );
    }
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      const retryAfter = Number(res.headers.get("retry-after")) || null;
      throw errorFromStatus(res.status, body?.error?.message ?? res.statusText, retryAfter);
    }

    const state: StreamState = {
      model: request.model,
      text: "",
      blockTypes: new Map(),
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    let lastReported = 0;
    try {
      for await (const { data } of sseEvents(res.body)) {
        const event = JSON.parse(data) as StreamEvent;
        switch (event.type) {
          case "message_start": {
            const usage = event.message?.usage ?? {};
            state.model = event.message?.model ?? state.model;
            state.usage.inputTokens = usage.input_tokens ?? 0;
            state.usage.cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            state.usage.cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
            request.onProgress?.({ type: "started", model: state.model });
            break;
          }
          case "content_block_start":
            state.blockTypes.set(event.index, event.content_block?.type ?? "unknown");
            // A fallback block means another model took over; drop the declined partial output.
            if (event.content_block?.type === "fallback") state.text = "";
            break;
          case "content_block_delta":
            if (
              event.delta?.type === "text_delta" &&
              state.blockTypes.get(event.index) === "text"
            ) {
              state.text += event.delta.text ?? "";
              const estimate = Math.round(state.text.length / 4);
              if (estimate - lastReported >= 200) {
                lastReported = estimate;
                request.onProgress?.({ type: "tokens", outputTokens: estimate });
              }
            }
            break;
          case "message_delta":
            state.stopReason = event.delta?.stop_reason ?? state.stopReason;
            state.usage.outputTokens = event.usage?.output_tokens ?? state.usage.outputTokens;
            break;
          case "error": {
            const type = event.error?.type ?? "error";
            const message = event.error?.message ?? "Unknown error";
            throw type === "overloaded_error"
              ? new AiError("overloaded", "The Anthropic API is overloaded. Retrying.", true)
              : new AiError("invalid-request", message);
          }
        }
      }
    } catch (error) {
      if (error instanceof AiError) throw error;
      if (request.signal?.aborted) throw new AiError("aborted", "Cancelled.");
      throw new AiError("network", `The response stream broke: ${(error as Error).message}`, true);
    }
    return { text: state.text, state };
  }

  async run<T>(request: AiRequest<T>): Promise<AiResult<T>> {
    const key = this.#apiKey();
    if (!key) throw new AiError("auth", "No Anthropic API key. Add one in Settings.");
    const started = Date.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const { text, state } = await this.#attempt(request, key);
        const usage: Usage = { ...state.usage, costUsd: estimateCost(state.model, state.usage) };
        if (state.stopReason === "refusal") {
          throw new AiError("refusal", "The model declined this request.");
        }
        if (state.stopReason === "max_tokens") {
          throw new AiError(
            "max-tokens",
            "The answer was cut off (output limit reached).",
            false,
            text,
          );
        }
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new AiError("invalid-output", "The model returned malformed JSON.", false, text);
        }
        const parsed = request.schema.safeParse(json);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .slice(0, 8)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          throw new AiError(
            "invalid-output",
            `The answer did not match the expected shape: ${issues}`,
            false,
            text,
          );
        }
        return {
          output: parsed.data,
          usage,
          engine: this.id,
          model: state.model,
          durationMs: Date.now() - started,
        };
      } catch (error) {
        const retryable = error instanceof AiError && error.retryable && attempt < 3;
        if (!retryable) throw error;
        request.onProgress?.({ type: "retry", attempt, reason: (error as AiError).message });
        await sleep(this.#retryDelayMs * attempt);
      }
    }
  }
}
