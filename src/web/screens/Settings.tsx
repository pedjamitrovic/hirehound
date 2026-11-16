import type { Diagnostic } from "../../shared/schemas/api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { Notice } from "../components/ui.tsx";
import { workspace } from "../state/store.ts";
import { type Theme, theme } from "../state/theme.ts";

export function DiagnosticList(props: { items: Diagnostic[] }) {
  return (
    <ul class="diagnostics">
      {props.items.map((d, i) => (
        <li key={`${d.file}:${d.line ?? 0}:${i}`}>
          <span style={{ color: d.severity === "error" ? "var(--danger)" : "var(--warning)" }}>
            <Icon name="alert" size={14} title={d.severity} />
          </span>
          <span>{d.message}</span>
          <span class="where">
            {d.file}
            {d.line ? `:${d.line}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsScreen(props: ScreenProps) {
  const info = workspace.value;
  if (!info) return null;
  const problems = info.diagnostics;

  return (
    <>
      {props.frame("Settings")}
      <div class="content">
        <div class="page" style={{ display: "grid", gap: "16px", maxWidth: "860px" }}>
          <section class="card">
            <header class="card-header">
              <h2>Workspace</h2>
            </header>
            <div class="card-body">
              <dl class="kv">
                <dt>Folder</dt>
                <dd>
                  <code>{info.path}</code>
                </dd>
                <dt>Jobs</dt>
                <dd class="num">{info.jobCount}</dd>
                <dt>Live sync</dt>
                <dd>
                  {info.watcher === "watching"
                    ? "Watching for file changes"
                    : "Polling for changes every 2 seconds (native file watching is unavailable)"}
                </dd>
                <dt>Git</dt>
                <dd>
                  {info.git
                    ? `Inside a git repository at ${info.git.root}${
                        info.git.remotes.length ? "" : " (no remotes)"
                      }`
                    : "Not in a git repository. A private repository is a good way to back up this folder."}
                </dd>
                <dt>Version</dt>
                <dd>Hirehound {info.appVersion}</dd>
              </dl>
              <p class="muted" style={{ marginTop: "12px" }}>
                To use another folder, start Hirehound with <code>--workspace</code>, set{" "}
                <code>HIREHOUND_WORKSPACE</code>, or set <code>workspace</code> in{" "}
                <code>~/.config/hirehound/config.yaml</code>.
              </p>
            </div>
          </section>

          <section class="card">
            <header class="card-header">
              <h2>File problems{problems.length ? ` (${problems.length})` : ""}</h2>
            </header>
            <div class="card-body">
              {problems.length ? (
                <DiagnosticList items={problems} />
              ) : (
                <span class="muted">No problems found in workspace files.</span>
              )}
            </div>
          </section>

          <section class="card">
            <header class="card-header">
              <h2>Appearance</h2>
            </header>
            <div class="card-body">
              <fieldset class="btn-group">
                <legend class="visually-hidden">Theme</legend>
                {THEMES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    class="btn"
                    aria-pressed={theme.value === t.value}
                    onClick={() => {
                      theme.value = t.value;
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </fieldset>
            </div>
          </section>

          <section class="card">
            <header class="card-header">
              <h2>AI engine</h2>
            </header>
            <div class="card-body">
              <Notice>
                Choosing between the Anthropic API (API key) and your Claude Code login arrives in
                M2, together with evaluation and tailoring. Your API key will never be stored in the
                workspace.
              </Notice>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
