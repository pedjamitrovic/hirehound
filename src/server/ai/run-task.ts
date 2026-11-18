import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { localIsoDateTime } from "../../shared/time.ts";
import { isNotFound } from "../workspace/fsx.ts";
import type { AiService } from "./service.ts";
import {
  AiError,
  type AiProgress,
  type AiResult,
  type Attachment,
  addUsage,
  type Effort,
} from "./types.ts";

export type TaskDef<I, O> = {
  /** Also the prompt file name: prompts/<name>.md (a workspace file overrides the built-in one). */
  name: string;
  schema: z.ZodType<O>;
  effort: Effort;
  maxOutputTokens?: number;
  /** Builds the user message from the input. The prompt file is the system prompt. */
  render(input: I): { input: string; attachments?: Attachment[] };
  /** Deterministic checks on top of the schema; problems trigger one repair attempt. */
  postCheck?(output: O, input: I): string[];
  /**
   * When the repair attempt still fails postCheck, return it with its problems instead of failing.
   * For outputs the user reviews and fixes anyway (a tailored CV whose checks then block it).
   */
  lenient?: boolean;
};

export type TaskResult<O> = AiResult<O> & {
  /** postCheck problems left after the repair attempt (only for lenient tasks). */
  problems: string[];
};

const BUILT_IN_PROMPTS = new URL("./prompts/", import.meta.url);

export async function loadPrompt(
  root: string,
  name: string,
): Promise<{ text: string; overridden: boolean }> {
  try {
    const text = await readFile(join(root, "prompts", `${name}.md`), "utf8");
    if (text.trim()) return { text, overridden: true };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return {
    text: await readFile(new URL(`${name}.md`, BUILT_IN_PROMPTS), "utf8"),
    overridden: false,
  };
}

export type TaskRunOptions = {
  /** Workspace root: prompt overrides and the usage log live here. */
  root: string;
  /** Job id: usage is also logged to jobs/<id>/ai-log.jsonl, for the per-job cost. */
  jobId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: AiProgress) => void;
};

async function logUsage(file: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is informational; never fail a task because of it.
  }
}

/**
 * Runs one AI task: renders the prompt, calls the configured engine, validates the output with the
 * task's schema and deterministic checks, and makes one repair attempt that feeds the problems back.
 * Usage (tokens, estimated cost) is appended to ai-log.jsonl in the workspace.
 */
export async function runTask<I, O>(
  ai: AiService,
  def: TaskDef<I, O>,
  input: I,
  options: TaskRunOptions,
): Promise<TaskResult<O>> {
  const engine = ai.engine();
  const model = ai.model();
  const prompt = await loadPrompt(options.root, def.name);
  const rendered = def.render(input);
  const started = Date.now();
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0 as number | null,
  };

  const attempt = (extra: string) =>
    engine.run({
      task: def.name,
      system: prompt.text,
      input: rendered.input + extra,
      ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
      schema: def.schema,
      model,
      effort: def.effort,
      ...(def.maxOutputTokens ? { maxOutputTokens: def.maxOutputTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });

  const finish = async (ok: boolean, servedBy: string, error?: string) => {
    const entry = {
      at: localIsoDateTime(),
      task: def.name,
      ...(options.jobId ? { job: options.jobId } : {}),
      engine: engine.id,
      model: servedBy,
      ok,
      prompt_override: prompt.overridden,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cost_usd: usage.costUsd,
      duration_ms: Date.now() - started,
      ...(error ? { error } : {}),
    };
    await logUsage(join(options.root, "ai-log.jsonl"), entry);
    if (options.jobId) {
      await logUsage(join(options.root, "jobs", options.jobId, "ai-log.jsonl"), entry);
    }
  };

  let problems: string[] = [];
  for (let round = 1; round <= 2; round++) {
    const extra =
      round === 1
        ? ""
        : `\n\nYour previous answer had these problems. Return a corrected, complete answer:\n${problems.map((p) => `- ${p}`).join("\n")}`;
    try {
      const result = await attempt(extra);
      usage = addUsage(usage, result.usage);
      problems = def.postCheck?.(result.output, input) ?? [];
      if (problems.length === 0 || (def.lenient && round === 2)) {
        await finish(true, result.model);
        return { ...result, usage, durationMs: Date.now() - started, problems };
      }
      options.onProgress?.({
        type: "retry",
        attempt: round,
        reason: problems[0] ?? "checks failed",
      });
    } catch (error) {
      if (!(error instanceof AiError) || error.code !== "invalid-output" || round === 2) {
        await finish(false, model, (error as Error).message);
        throw error;
      }
      problems = [error.message];
      options.onProgress?.({ type: "retry", attempt: round, reason: error.message });
    }
  }
  await finish(false, model, problems.join("; "));
  throw new AiError(
    "invalid-output",
    `The answer still failed checks: ${problems.slice(0, 5).join("; ")}`,
  );
}
