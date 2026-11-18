import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { toYaml } from "../../shared/frontmatter.ts";
import type { AiSettings } from "../../shared/schemas/api.ts";
import { AppConfig } from "../config.ts";
import { isNotFound } from "../workspace/fsx.ts";
import { updateYamlText } from "../workspace/yaml-edit.ts";
import { AnthropicApiEngine } from "./anthropic.ts";
import { ClaudeCodeEngine } from "./claude-code.ts";
import type { AiEngine, EngineHealth, EngineId } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_ENGINE: EngineId = "anthropic-api";

const CREDENTIALS_FILE = "credentials.yaml";

type Options = {
  configDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Tests inject an engine instead of talking to Anthropic or spawning Claude Code. */
  engine?: AiEngine;
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * AI settings and engines. Configuration lives in ~/.config/hirehound/config.yaml and the API key
 * in ~/.config/hirehound/credentials.yaml (or ANTHROPIC_API_KEY): never in the workspace.
 */
export class AiService {
  readonly #configDir: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #override: AiEngine | undefined;
  #fileKey: string | null = null;
  #config: AppConfig = {};

  constructor(options: Options) {
    this.#configDir = options.configDir;
    this.#env = options.env ?? process.env;
    this.#fetchImpl = options.fetchImpl;
    this.#override = options.engine;
  }

  /** Reads config and credentials from disk. Call once at startup and after external edits. */
  async load(): Promise<void> {
    const configText = await readText(join(this.#configDir, "config.yaml"));
    const config = AppConfig.safeParse(configText ? (parse(configText) ?? {}) : {});
    this.#config = config.success ? config.data : {};
    const credentials = await readText(join(this.#configDir, CREDENTIALS_FILE));
    const parsed = credentials
      ? (parse(credentials) as { anthropic_api_key?: unknown } | null)
      : null;
    const key = parsed?.anthropic_api_key;
    this.#fileKey = typeof key === "string" && key.trim() ? key.trim() : null;
  }

  #apiKey(): { key: string | null; source: "env" | "file" | null } {
    const fromEnv = this.#env.ANTHROPIC_API_KEY?.trim();
    if (fromEnv) return { key: fromEnv, source: "env" };
    if (this.#fileKey) return { key: this.#fileKey, source: "file" };
    return { key: null, source: null };
  }

  settings(): AiSettings {
    const { source } = this.#apiKey();
    return {
      engine: this.#config.ai?.engine ?? DEFAULT_ENGINE,
      model: this.#config.ai?.model ?? DEFAULT_MODEL,
      apiKey: { present: source !== null, source },
    };
  }

  async update(patch: { engine?: EngineId; model?: string }): Promise<AiSettings> {
    const file = join(this.#configDir, "config.yaml");
    const text = await readText(file);
    const current = AppConfig.safeParse(text ? (parse(text) ?? {}) : {});
    const next: AppConfig = {
      ...(current.success ? current.data : {}),
      ai: { ...(current.success ? current.data.ai : {}), ...patch },
    };
    await mkdir(this.#configDir, { recursive: true });
    await writeFile(
      file,
      updateYamlText(text, next, "# Hirehound settings (not workspace data)\n"),
    );
    this.#config = next;
    return this.settings();
  }

  /** Saves the key readable by the current user only; null removes it. */
  async setApiKey(key: string | null): Promise<AiSettings> {
    const file = join(this.#configDir, CREDENTIALS_FILE);
    if (key === null || key.trim() === "") {
      await rm(file, { force: true });
      this.#fileKey = null;
      return this.settings();
    }
    await mkdir(this.#configDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const content = `# Hirehound credentials. Keep this file private.\n${toYaml({ anthropic_api_key: key.trim() })}`;
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, file);
    await chmod(file, 0o600).catch(() => {});
    this.#fileKey = key.trim();
    return this.settings();
  }

  engine(): AiEngine {
    if (this.#override) return this.#override;
    if (this.settings().engine === "claude-code") return new ClaudeCodeEngine();
    return new AnthropicApiEngine({
      apiKey: () => this.#apiKey().key,
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
    });
  }

  model(): string {
    return this.settings().model;
  }

  health(): Promise<EngineHealth> {
    return this.engine().health(this.model());
  }
}
