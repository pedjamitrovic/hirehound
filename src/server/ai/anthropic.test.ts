import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { AnthropicApiEngine } from "./anthropic.ts";
import { AiError, type AiProgress } from "./types.ts";

const Output = z.object({ answer: z.string(), score: z.number().int().max(100) });

type Event = Record<string, unknown>;

function sse(events: Event[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Split mid-event to exercise buffering.
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });
}

function success(json: string, extra: Event[] = [], stop = "end_turn"): string {
  return sse([
    {
      type: "message_start",
      message: {
        model: "claude-opus-5-5",
        usage: { input_tokens: 1200, cache_read_input_tokens: 0 },
      },
    },
    ...extra,
    { type: "content_block_start", index: 9, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 9,
      delta: { type: "text_delta", text: json.slice(0, 5) },
    },
    { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: json.slice(5) } },
    { type: "content_block_stop", index: 9 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 80 } },
    { type: "message_stop" },
  ]);
}

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (body: string) => new Response(streamOf(body), { status: 200 });

const request = (onProgress?: (p: AiProgress) => void) => ({
  task: "test",
  system: "You are a test.",
  input: "Hello",
  attachments: [
    { kind: "pdf" as const, name: "cv.pdf", data: new TextEncoder().encode("%PDF-1.7") },
    { kind: "text" as const, name: "notes.md", text: "Some notes" },
  ],
  schema: Output,
  model: "claude-opus-5-5",
  effort: "high" as const,
  ...(onProgress ? { onProgress } : {}),
});

describe("AnthropicApiEngine.run", () => {
  it("streams, validates and reports usage with an estimated cost", async () => {
    const { fetchImpl, calls } = fakeFetch([ok(success('{"answer":"yes","score":90}'))]);
    const engine = new AnthropicApiEngine({ apiKey: () => "sk-test", fetchImpl, retryDelayMs: 0 });
    const progress: AiProgress[] = [];
    const result = await engine.run(request((p) => progress.push(p)));
    assert.deepEqual(result.output, { answer: "yes", score: 90 });
    assert.equal(result.usage.inputTokens, 1200);
    assert.equal(result.usage.outputTokens, 80);
    assert.equal(result.usage.costUsd, 0.0064);
    assert.equal(progress[0]?.type, "started");

    const call = calls[0];
    assert.equal(call?.url, "https://api.anthropic.com/v1/messages");
    const headers = call?.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-test");
    assert.equal(headers["anthropic-version"], "2026-10-21");
    const body = JSON.parse(String(call?.init.body));
    assert.equal(body.stream, true);
    assert.equal(body.output_config.format.type, "json_schema");
    assert.equal(body.output_config.format.schema.additionalProperties, false);
    assert.equal(body.output_config.effort, "high");
    assert.equal(body.messages[0].content[0].source.media_type, "application/pdf");
    assert.equal(body.messages[0].content[1].source.type, "text");
    assert.equal(body.messages[0].content[2].text, "Hello");
  });

  it("drops output from a model that declined before a fallback took over", async () => {
    const declined: Event[] = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"answ' } },
      { type: "content_block_start", index: 1, content_block: { type: "fallback" } },
    ];
    const { fetchImpl } = fakeFetch([ok(success('{"answer":"ok","score":1}', declined))]);
    const engine = new AnthropicApiEngine({ apiKey: () => "k", fetchImpl, retryDelayMs: 0 });
    assert.deepEqual((await engine.run(request())).output, { answer: "ok", score: 1 });
  });

  it("retries overloaded and network errors, then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      new Response(JSON.stringify({ error: { message: "busy" } }), { status: 529 }),
      new TypeError("socket hang up"),
      ok(success('{"answer":"a","score":2}')),
    ]);
    const engine = new AnthropicApiEngine({ apiKey: () => "k", fetchImpl, retryDelayMs: 0 });
    const progress: AiProgress[] = [];
    const result = await engine.run(request((p) => progress.push(p)));
    assert.equal(result.output.answer, "a");
    assert.equal(calls.length, 3);
    assert.equal(progress.filter((p) => p.type === "retry").length, 2);
  });

  it("maps failures to clear, typed errors", async () => {
    const cases: [Response, string][] = [
      [new Response("{}", { status: 401 }), "auth"],
      [
        new Response(JSON.stringify({ error: { message: "bad field" } }), { status: 400 }),
        "invalid-request",
      ],
      [ok(success("", [], "refusal")), "refusal"],
      [ok(success('{"answer":"cut', [], "max_tokens")), "max-tokens"],
      [ok(success("not json")), "invalid-output"],
      [ok(success('{"answer":"x","score":500}')), "invalid-output"],
    ];
    for (const [response, code] of cases) {
      const { fetchImpl } = fakeFetch([response]);
      const engine = new AnthropicApiEngine({ apiKey: () => "k", fetchImpl, retryDelayMs: 0 });
      await assert.rejects(engine.run(request()), (error: AiError) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, code);
        return true;
      });
    }
  });

  it("refuses to run without a key", async () => {
    const engine = new AnthropicApiEngine({ apiKey: () => null });
    await assert.rejects(engine.run(request()), (error: AiError) => error.code === "auth");
  });
});

describe("AnthropicApiEngine.health", () => {
  it("checks the key against the model endpoint", async () => {
    const missing = await new AnthropicApiEngine({ apiKey: () => null }).health("claude-opus-5-5");
    assert.equal(missing.ok, false);

    const { fetchImpl, calls } = fakeFetch([
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 401 }),
    ]);
    const engine = new AnthropicApiEngine({ apiKey: () => "k", fetchImpl });
    assert.equal((await engine.health("claude-opus-5-5")).ok, true);
    assert.equal(calls[0]?.url, "https://api.anthropic.com/v1/models/claude-opus-5-5");
    const bad = await engine.health("claude-opus-5-5");
    assert.equal(!bad.ok && bad.reason, "invalid-key");
  });
});
