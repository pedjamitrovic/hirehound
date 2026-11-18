import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AiSettings } from "../../../shared/schemas/api.ts";
import { api, errorMessage } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Notice } from "../../components/ui.tsx";
import { toast } from "../../state/toasts.ts";

type Engine = AiSettings["engine"];
type CheckResult = { ok: boolean; detail: string };

const ENGINES: { value: Engine; label: string; hint: string }[] = [
  {
    value: "anthropic-api",
    label: "Anthropic API",
    hint: "Uses an API key. Usage is billed to your Anthropic account.",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    hint: "Uses your existing Claude Code login. Needs the claude command installed.",
  },
];

const MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (default)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster, cheaper)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2 (most capable, most expensive)" },
];

const OTHER = "other";

function SuccessNotice(props: { children: ComponentChildren }) {
  return (
    <div class="notice success" role="status">
      <Icon name="check" size={14} />
      <div>{props.children}</div>
    </div>
  );
}

function CheckNotice(props: { result: CheckResult }) {
  return props.result.ok ? (
    <SuccessNotice>{props.result.detail}</SuccessNotice>
  ) : (
    <Notice kind="danger">{props.result.detail}</Notice>
  );
}

/** Which engine and model run AI tasks, the API key, and a connection test. */
export function AiSettingsCard() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [otherModel, setOtherModel] = useState(false);
  const [modelText, setModelText] = useState("");
  const [key, setKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<CheckResult | null>(null);
  const modelInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.aiSettings().then(
      (next) => {
        if (cancelled) return;
        setSettings(next);
        setLoadError(null);
        if (!MODELS.some((m) => m.id === next.model)) setModelText(next.model);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (otherModel) modelInput.current?.focus();
  }, [otherModel]);

  if (!settings) {
    return (
      <section class="card">
        <header class="card-header">
          <h2>AI engine</h2>
        </header>
        <div class="card-body">
          {loadError ? (
            <Notice kind="danger">
              Could not load AI settings. {loadError}{" "}
              <button type="button" class="btn small" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </Notice>
          ) : (
            <span class="muted">Loading...</span>
          )}
        </div>
      </section>
    );
  }

  const knownModel = MODELS.some((m) => m.id === settings.model);
  const showOther = otherModel || !knownModel;
  const engine = ENGINES.find((e) => e.value === settings.engine);

  const patch = async (change: { engine?: Engine; model?: string }) => {
    if (saving) return;
    const previous = settings;
    setSettings({ ...settings, ...change });
    setTest(null);
    setSaving(true);
    try {
      setSettings(await api.saveAiSettings(change));
      toast("AI settings saved", "success");
    } catch (error) {
      setSettings(previous);
      toast(`Could not save AI settings: ${errorMessage(error)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveOtherModel = () => {
    const model = modelText.trim();
    if (model && model !== settings.model) void patch({ model });
  };

  const saveKey = async () => {
    const value = key.trim();
    if (!value || keyBusy) return;
    setKeyBusy(true);
    try {
      setSettings(await api.saveApiKey(value));
      setKey("");
      setTest(null);
      toast("API key saved", "success");
    } catch (error) {
      toast(`Could not save the API key: ${errorMessage(error)}`, "error");
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (
      keyBusy ||
      !window.confirm(
        "Remove the saved API key? Hirehound cannot use the Anthropic API until you add one again.",
      )
    ) {
      return;
    }
    setKeyBusy(true);
    try {
      setSettings(await api.saveApiKey(null));
      setTest(null);
      toast("API key removed", "success");
    } catch (error) {
      toast(`Could not remove the API key: ${errorMessage(error)}`, "error");
    } finally {
      setKeyBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTest(null);
    try {
      const result = await api.testAi();
      setTest({ ok: result.ok, detail: result.detail });
    } catch (error) {
      setTest({ ok: false, detail: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section class="card">
      <header class="card-header">
        <h2>AI engine</h2>
      </header>
      <div class="card-body form-body">
        <div class="field">
          <span class="label">Engine</span>
          <fieldset class="btn-group">
            <legend class="visually-hidden">Engine</legend>
            {ENGINES.map((e) => (
              <button
                key={e.value}
                type="button"
                class="btn"
                aria-pressed={settings.engine === e.value}
                disabled={saving}
                onClick={() => {
                  if (settings.engine !== e.value) void patch({ engine: e.value });
                }}
              >
                {e.label}
              </button>
            ))}
          </fieldset>
          {engine ? <span class="hint">{engine.hint}</span> : null}
        </div>

        <div class="field">
          <label for="ai-model">Model</label>
          <select
            id="ai-model"
            class="select"
            value={showOther ? OTHER : settings.model}
            disabled={saving}
            onChange={(ev) => {
              const value = ev.currentTarget.value;
              if (value === OTHER) {
                setOtherModel(true);
                setModelText(knownModel ? "" : settings.model);
                return;
              }
              setOtherModel(false);
              if (value !== settings.model) void patch({ model: value });
            }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={OTHER}>Other...</option>
          </select>
          {showOther ? (
            <div class="inline-form">
              <input
                ref={modelInput}
                class="input"
                aria-label="Model id"
                placeholder="claude-opus-5-5"
                spellcheck={false}
                autocomplete="off"
                value={modelText}
                onInput={(ev) => setModelText(ev.currentTarget.value)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    saveOtherModel();
                  }
                }}
              />
              <button
                type="button"
                class="btn"
                disabled={saving || !modelText.trim() || modelText.trim() === settings.model}
                onClick={saveOtherModel}
              >
                Use model
              </button>
            </div>
          ) : null}
          {showOther ? (
            <span class="hint">
              Currently using <code>{settings.model}</code>.
            </span>
          ) : null}
        </div>

        {settings.engine === "anthropic-api" ? (
          <div class="field">
            <span class="label">API key</span>
            {settings.apiKey.source === "env" ? (
              <span class="secondary">
                Using the key from the <code>ANTHROPIC_API_KEY</code> environment variable.
              </span>
            ) : (
              <>
                <span class="secondary">
                  {settings.apiKey.present ? "A key is saved." : "No key saved yet."}
                </span>
                <form
                  class="inline-form"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    void saveKey();
                  }}
                >
                  <input
                    class="input"
                    type="password"
                    aria-label="API key"
                    placeholder={
                      settings.apiKey.present ? "Paste a new key to replace it" : "sk-ant-..."
                    }
                    autocomplete="off"
                    spellcheck={false}
                    value={key}
                    onInput={(ev) => setKey(ev.currentTarget.value)}
                  />
                  <button type="submit" class="btn" disabled={keyBusy || !key.trim()}>
                    {keyBusy ? "Saving..." : "Save key"}
                  </button>
                </form>
                <span class="hint">
                  Stored in <code>~/.config/hirehound/credentials.yaml</code>, readable only by your
                  user, and never in the workspace. Hirehound never shows the key again.
                </span>
                {settings.apiKey.present ? (
                  <div>
                    <button
                      type="button"
                      class="btn ghost small danger"
                      disabled={keyBusy}
                      onClick={() => void removeKey()}
                    >
                      Remove saved key
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div class="form-actions">
          <button type="button" class="btn" disabled={testing} onClick={() => void runTest()}>
            {testing ? "Testing..." : "Test connection"}
          </button>
        </div>
        {test ? <CheckNotice result={test} /> : null}
      </div>
    </section>
  );
}

/** Which installed browser renders PDFs, or why none was found. */
export function PdfStatusCard() {
  const [status, setStatus] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    api.pdfStatus().then(
      (result) => {
        if (cancelled) return;
        setStatus(result);
        setChecking(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setStatus({ ok: false, detail: errorMessage(error) });
        setChecking(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <section class="card">
      <header class="card-header">
        <h2>PDF rendering</h2>
        <div class="actions">
          <button
            type="button"
            class="btn small"
            disabled={checking}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {checking ? "Checking..." : "Check again"}
          </button>
        </div>
      </header>
      <div class="card-body form-body">
        <p class="secondary">
          PDFs are rendered by the Chrome or Edge already installed on this computer.
        </p>
        {status === null ? (
          <span class="muted">Checking...</span>
        ) : status.ok ? (
          <SuccessNotice>Rendering with {status.detail}.</SuccessNotice>
        ) : (
          <Notice kind="danger">{status.detail}</Notice>
        )}
      </div>
    </section>
  );
}
