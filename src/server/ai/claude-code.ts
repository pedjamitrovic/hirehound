import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { toOutputSchema } from "./json-schema.ts";
import {
  type AiEngine,
  AiError,
  type AiRequest,
  type AiResult,
  type EngineHealth,
  type Usage,
} from "./types.ts";

/** How to start Claude Code: an executable, or node + the CLI script behind an npm .cmd shim. */
export type ClaudeCommand = { command: string; prefixArgs: string[] };

/**
 * Finds the `claude` CLI. On Windows an npm install is a `.cmd` shim, which Node cannot spawn
 * without a shell (and a shell would mangle the JSON schema argument), so we run the script it
 * points to with this Node binary instead.
 */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): ClaudeCommand | null {
  const windows = process.platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  dirs.push(join(homedir(), ".local", "bin"), join(homedir(), ".claude", "local"));
  const names = windows ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      if (!candidate.endsWith(".cmd")) return { command: candidate, prefixArgs: [] };
      const shim = readFileSync(candidate, "utf8");
      const script = /"%(?:~?dp0)%\\?([^"]+?\.(?:c|m)?js)"/i.exec(shim)?.[1];
      if (script) {
        const path = resolve(dirname(candidate), script);
        if (existsSync(path)) return { command: process.execPath, prefixArgs: [path] };
      }
    }
  }
  return null;
}

type RunOutput = { code: number | null; stdout: string; stderr: string };

function run(
  cmd: ClaudeCommand,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd.command, [...cmd.prefixArgs, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

type ClaudeJson = {
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
};

/**
 * Headless Claude Code (`claude -p`), so people can use their existing Claude Code login instead
 * of an API key. Runs in an empty temp folder with all tools off (Read only for attached PDFs),
 * so no project settings, hooks or files are involved.
 */
export class ClaudeCodeEngine implements AiEngine {
  readonly id = "claude-code" as const;
  readonly #resolve: () => ClaudeCommand | null;

  constructor(options: { resolve?: () => ClaudeCommand | null } = {}) {
    this.#resolve = options.resolve ?? (() => resolveClaude());
  }

  async health(): Promise<EngineHealth> {
    const cmd = this.#resolve();
    if (!cmd) {
      return {
        ok: false,
        reason: "not-installed",
        detail: "Claude Code (the claude command) was not found on this computer.",
      };
    }
    try {
      const out = await run(cmd, ["--version"], { cwd: tmpdir(), timeoutMs: 15_000 });
      if (out.code !== 0)
        return {
          ok: false,
          reason: "error",
          detail: out.stderr.trim() || "claude --version failed",
        };
      return {
        ok: true,
        detail: `Claude Code ${out.stdout.trim()} found. Requests use its login.`,
      };
    } catch (error) {
      return { ok: false, reason: "error", detail: (error as Error).message };
    }
  }

  async run<T>(request: AiRequest<T>): Promise<AiResult<T>> {
    const cmd = this.#resolve();
    if (!cmd)
      throw new AiError(
        "unavailable",
        "Claude Code was not found. Install it or switch to the API in Settings.",
      );
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "hirehound-ai-"));
    try {
      const systemFile = join(dir, "system.md");
      await writeFile(systemFile, request.system);
      const pdfs: string[] = [];
      let prompt = "";
      for (const [i, attachment] of (request.attachments ?? []).entries()) {
        if (attachment.kind === "pdf") {
          const file = join(dir, `attachment-${i + 1}.pdf`);
          await writeFile(file, attachment.data);
          pdfs.push(file);
          prompt += `Attached PDF "${attachment.name}": read the file ${file}\n`;
        } else {
          prompt += `<document title="${attachment.name.replace(/"/g, "'")}">\n${attachment.text}\n</document>\n\n`;
        }
      }
      prompt += request.input;

      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(toOutputSchema(request.schema)),
        "--system-prompt-file",
        systemFile,
        "--no-session-persistence",
        "--model",
        request.model,
      ];
      if (pdfs.length) args.push("--tools", "Read", "--allowedTools", "Read", "--add-dir", dir);
      else args.push("--tools", "");

      request.onProgress?.({ type: "started", model: request.model });
      const out = await run(cmd, args, {
        cwd: dir,
        input: prompt,
        timeoutMs: 15 * 60_000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (request.signal?.aborted) throw new AiError("aborted", "Cancelled.");

      let json: ClaudeJson;
      try {
        json = JSON.parse(out.stdout) as ClaudeJson;
      } catch {
        throw new AiError(
          "unavailable",
          `Claude Code failed: ${(out.stderr || out.stdout).trim().slice(0, 300) || `exit code ${out.code}`}`,
        );
      }
      const usage: Usage = {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
        costUsd: json.total_cost_usd ?? null,
      };
      if (json.is_error && json.structured_output === undefined) {
        const message = json.result ?? "Claude Code reported an error.";
        const code = /log ?in|auth|credential/i.test(message) ? "auth" : "unavailable";
        throw new AiError(code, message);
      }
      if (json.structured_output === undefined) {
        throw new AiError(
          "invalid-output",
          "Claude Code returned no structured output.",
          false,
          json.result,
        );
      }
      const parsed = request.schema.safeParse(json.structured_output);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new AiError(
          "invalid-output",
          `The answer did not match the expected shape: ${issues}`,
          false,
          JSON.stringify(json.structured_output),
        );
      }
      const model = Object.keys(json.modelUsage ?? {})[0] ?? request.model;
      return {
        output: parsed.data,
        usage,
        engine: this.id,
        model,
        durationMs: Date.now() - started,
      };
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
