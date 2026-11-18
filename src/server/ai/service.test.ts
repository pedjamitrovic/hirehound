import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { tempDir } from "../../../test/helpers.ts";
import { FakeEngine } from "./fake.ts";
import { toOutputSchema } from "./json-schema.ts";
import { runTask, type TaskDef } from "./run-task.ts";
import { AiService } from "./service.ts";
import type { AiError } from "./types.ts";

describe("AiService", () => {
  it("defaults to the API engine and Opus, and never exposes the key", async () => {
    const dir = await tempDir();
    try {
      const ai = new AiService({ configDir: dir.path, env: {} });
      await ai.load();
      assert.deepEqual(ai.settings(), {
        engine: "anthropic-api",
        model: "claude-opus-5-5",
        apiKey: { present: false, source: null },
      });

      const saved = await ai.setApiKey("  sk-ant-secret  ");
      assert.deepEqual(saved.apiKey, { present: true, source: "file" });
      assert.doesNotMatch(JSON.stringify(saved), /secret/);
      const file = await readFile(join(dir.path, "credentials.yaml"), "utf8");
      assert.match(file, /anthropic_api_key: sk-ant-secret/);
      if (process.platform !== "win32") {
        assert.equal((await stat(join(dir.path, "credentials.yaml"))).mode & 0o777, 0o600);
      }

      const fresh = new AiService({ configDir: dir.path, env: {} });
      await fresh.load();
      assert.equal(fresh.settings().apiKey.source, "file");

      const env = new AiService({ configDir: dir.path, env: { ANTHROPIC_API_KEY: "sk-env" } });
      await env.load();
      assert.equal(env.settings().apiKey.source, "env");

      await ai.setApiKey(null);
      assert.equal(ai.settings().apiKey.present, false);
    } finally {
      await dir.cleanup();
    }
  });

  it("updates config.yaml without losing other settings or comments", async () => {
    const dir = await tempDir();
    try {
      await mkdir(dir.path, { recursive: true });
      await writeFile(join(dir.path, "config.yaml"), "# mine\nworkspace: ~/ws\n");
      const ai = new AiService({ configDir: dir.path, env: {} });
      await ai.load();
      const next = await ai.update({ engine: "claude-code", model: "claude-sonnet-5-5" });
      assert.equal(next.engine, "claude-code");
      const text = await readFile(join(dir.path, "config.yaml"), "utf8");
      assert.match(
        text,
        /^# mine\nworkspace: ~\/ws\nai:\n {2}engine: claude-code\n {2}model: claude-sonnet-5-5\n$/,
      );
    } finally {
      await dir.cleanup();
    }
  });
});

describe("toOutputSchema", () => {
  it("keeps the shape, drops unsupported constraints and closes objects", () => {
    const schema = toOutputSchema(
      z.object({
        name: z.string().min(1).max(10),
        id: z.string().regex(/^A-\d+$/),
        tags: z.array(z.string()).min(1).default([]),
        nested: z.object({ n: z.number().int().max(5) }),
        kind: z.enum(["a", "b"]),
      }),
    );
    const text = JSON.stringify(schema);
    for (const keyword of [
      "minLength",
      "maxLength",
      "pattern",
      "minItems",
      "maximum",
      "$schema",
      "default",
    ]) {
      assert.doesNotMatch(text, new RegExp(`"${keyword}"`), keyword);
    }
    assert.equal(schema.additionalProperties, false);
    assert.equal(
      (schema.properties as Record<string, { additionalProperties?: boolean }>).nested
        ?.additionalProperties,
      false,
    );
    assert.deepEqual(schema.required, ["name", "id", "nested", "kind"]);
  });
});

const Output = z.object({ items: z.array(z.string()) });

const def: TaskDef<{ want: number }, z.infer<typeof Output>> = {
  name: "test-task",
  schema: Output,
  effort: "low",
  render: (input) => ({ input: `Give me ${input.want} items` }),
  postCheck: (output, input) =>
    output.items.length === input.want
      ? []
      : [`expected ${input.want} items, got ${output.items.length}`],
};

describe("runTask", () => {
  it("uses the workspace prompt override, repairs once and logs usage", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "prompts"));
      await writeFile(join(dir.path, "prompts", "test-task.md"), "Custom instructions");
      const engine = new FakeEngine({
        "test-task": [() => ({ items: ["a"] }), () => ({ items: ["a", "b"] })],
      });
      const ai = new AiService({ configDir: dir.path, env: {}, engine });
      const result = await runTask(ai, def, { want: 2 }, { root: dir.path });
      assert.deepEqual(result.output.items, ["a", "b"]);
      assert.equal(engine.requests.length, 2);
      assert.equal(engine.requests[0]?.system, "Custom instructions");
      assert.match(engine.requests[1]?.input ?? "", /expected 2 items, got 1/);
      assert.equal(result.usage.inputTokens, 200);

      const log = (await readFile(join(dir.path, "ai-log.jsonl"), "utf8")).trim().split("\n");
      const entry = JSON.parse(log[0] ?? "{}");
      assert.equal(entry.task, "test-task");
      assert.equal(entry.ok, true);
      assert.equal(entry.prompt_override, true);
    } finally {
      await dir.cleanup();
    }
  });

  it("gives up after the repair attempt and logs the failure", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir.path, "prompts"));
      await writeFile(join(dir.path, "prompts", "test-task.md"), "x");
      const engine = new FakeEngine({ "test-task": () => ({ items: [] }) });
      const ai = new AiService({ configDir: dir.path, env: {}, engine });
      await assert.rejects(runTask(ai, def, { want: 1 }, { root: dir.path }), (error: AiError) => {
        assert.equal(error.code, "invalid-output");
        return true;
      });
      const entry = JSON.parse((await readFile(join(dir.path, "ai-log.jsonl"), "utf8")).trim());
      assert.equal(entry.ok, false);
    } finally {
      await dir.cleanup();
    }
  });
});
