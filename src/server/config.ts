import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** ~/.config/hirehound/config.yaml on every OS (PRD section 6). Never inside the workspace. */
export const AppConfig = z.object({
  workspace: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ai: z
    .object({
      engine: z.enum(["anthropic-api", "claude-code"]).optional(),
      model: z.string().min(1).optional(),
    })
    .optional(),
});
export type AppConfig = z.infer<typeof AppConfig>;

export type WorkspaceSource = "flag" | "env" | "config" | "default";

export type ResolvedWorkspace = { path: string; source: WorkspaceSource };

export type ResolveInput = {
  flag?: string | undefined;
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  config: AppConfig;
  configDir: string;
};

export function configDir(home: string = homedir()): string {
  return join(home, ".config", "hirehound");
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

function absolute(path: string, home: string, base: string): string {
  const expanded = expandHome(path.trim(), home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** --workspace flag > HIREHOUND_WORKSPACE > config.yaml > ~/Documents/hirehound. */
export function resolveWorkspace(input: ResolveInput): ResolvedWorkspace {
  const { flag, env, home, cwd, config } = input;
  if (flag?.trim()) return { path: absolute(flag, home, cwd), source: "flag" };
  const fromEnv = env.HIREHOUND_WORKSPACE;
  if (fromEnv?.trim()) return { path: absolute(fromEnv, home, cwd), source: "env" };
  if (config.workspace) {
    return { path: absolute(config.workspace, home, input.configDir), source: "config" };
  }
  return { path: join(home, "Documents", "hirehound"), source: "default" };
}

/** Reads config.yaml; a missing file is an empty config, an invalid one is an error. */
export function loadAppConfig(dir: string = configDir()): AppConfig {
  const file = join(dir, "config.yaml");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const result = AppConfig.safeParse(parse(text) ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid ${file}: ${details}`);
  }
  return result.data;
}
