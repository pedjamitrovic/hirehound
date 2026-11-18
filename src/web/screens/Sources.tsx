import { useEffect, useRef, useState } from "preact/hooks";
import type { ScanEntry, SourcesView } from "../../shared/schemas/api.ts";
import type { Portal } from "../../shared/schemas/portals.ts";
import { api, errorMessage } from "../api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { TaskStatus } from "../components/TaskStatus.tsx";
import { age, EmptyState, formatDateTime, Link, Notice } from "../components/ui.tsx";
import { jobPath } from "../router.ts";
import { jobs, tasks } from "../state/store.ts";
import { toast } from "../state/toasts.ts";

const PROVIDER: Record<Portal["provider"], string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

const SCHEDULES = [0, 6, 12, 24, 48];

function boardPage(p: Pick<Portal, "provider" | "board" | "region">): string {
  const board = encodeURIComponent(p.board);
  if (p.provider === "greenhouse") return `https://boards.greenhouse.io/${board}`;
  if (p.provider === "lever")
    return `https://jobs${p.region === "eu" ? ".eu" : ""}.lever.co/${board}`;
  return `https://jobs.ashbyhq.com/${board}`;
}

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function slug(text: string): string {
  return (
    text
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "board"
  );
}

/** The newest scan or import task, if it is running or just failed. */
function useDiscoveryTask() {
  let latest = null as ReturnType<typeof tasks.value.get> | null;
  for (const task of tasks.value.values()) {
    if (task.kind !== "scan" && task.kind !== "import-alert") continue;
    if (!latest || task.startedAt > latest.startedAt) latest = task;
  }
  return latest ?? null;
}

type Draft = {
  company: string;
  provider: Portal["provider"];
  board: string;
  region: Portal["region"];
  titles: string;
  exclude: string;
  locations: string;
};

function PortalForm(props: {
  initial?: Portal;
  onSave: (portal: Omit<Portal, "id"> & { id?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const p = props.initial;
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState<Draft | null>(
    p
      ? {
          company: p.company,
          provider: p.provider,
          board: p.board,
          region: p.region,
          titles: p.titles.join(", "),
          exclude: p.exclude_titles.join(", "),
          locations: p.locations.join(", "),
        }
      : null,
  );
  const [busy, setBusy] = useState(false);

  const recognise = async () => {
    try {
      const b = await api.boardFromUrl(url.trim());
      setDraft({
        company: b.company,
        provider: b.provider,
        board: b.board,
        region: b.region,
        titles: "",
        exclude: "",
        locations: "",
      });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div class="portal-form">
      {!draft ? (
        <div class="assist-open">
          <input
            class="input"
            aria-label="Careers link"
            placeholder="https://boards.greenhouse.io/acme, jobs.lever.co/acme or jobs.ashbyhq.com/acme"
            value={url}
            onInput={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void recognise();
            }}
          />
          <button
            type="button"
            class="btn primary"
            disabled={!url.trim()}
            onClick={() => void recognise()}
          >
            Next
          </button>
          <button type="button" class="btn ghost" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div class="portal-board">
            <span class="badge">{PROVIDER[draft.provider]}</span>
            <a href={boardPage(draft)} target="_blank" rel="noopener noreferrer">
              {boardPage(draft).replace(/^https:\/\//, "")} <Icon name="external" size={11} />
            </a>
          </div>
          <div class="form-grid">
            <label class="field">
              <span>Company</span>
              <input
                class="input"
                value={draft.company}
                onInput={(e) => setDraft({ ...draft, company: e.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>Titles to keep (comma separated, empty: all)</span>
              <input
                class="input"
                placeholder="engineering manager, platform"
                value={draft.titles}
                onInput={(e) => setDraft({ ...draft, titles: e.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>Titles to drop</span>
              <input
                class="input"
                placeholder="intern, sales"
                value={draft.exclude}
                onInput={(e) => setDraft({ ...draft, exclude: e.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>Locations to keep (empty: anywhere)</span>
              <input
                class="input"
                placeholder="Berlin, Remote"
                value={draft.locations}
                onInput={(e) => setDraft({ ...draft, locations: e.currentTarget.value })}
              />
            </label>
          </div>
          <div class="step-actions">
            <button
              type="button"
              class="btn primary"
              disabled={busy || !draft.company.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await props.onSave({
                    ...(p ? { id: p.id } : {}),
                    company: draft.company.trim(),
                    provider: draft.provider,
                    board: draft.board,
                    region: draft.region,
                    titles: list(draft.titles),
                    exclude_titles: list(draft.exclude),
                    locations: list(draft.locations),
                    enabled: p?.enabled ?? true,
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {p ? "Save" : "Add this board"}
            </button>
            <button type="button" class="btn" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ScanCounts(props: { scan: ScanEntry }) {
  const s = props.scan;
  if (!s.ok) return <span class="danger-text">{s.error}</span>;
  return (
    <span class="scan-counts">
      <span>{s.listed} listed</span>
      <span class={s.added.length ? "success-text" : "muted"}>{s.added.length} added</span>
      <span class="muted">{s.filtered.length} filtered</span>
      {s.duplicates ? <span class="muted">{s.duplicates} known</span> : null}
      {s.gone.length ? <span class="warning-text">{s.gone.length} no longer listed</span> : null}
    </span>
  );
}

function ScanRow(props: {
  scan: ScanEntry;
  name: string;
  onAdd: (source: string, ref: string) => void;
}) {
  const s = props.scan;
  const [open, setOpen] = useState(false);
  const known = jobs.value;
  const detail = s.added.length + s.filtered.length + s.gone.length + s.back.length > 0;
  return (
    <li class="scan-row">
      <button
        type="button"
        class="scan-head"
        aria-expanded={detail ? open : undefined}
        onClick={() => setOpen(!open)}
        disabled={!detail}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span class="scan-name">{props.name}</span>
        <ScanCounts scan={s} />
        <span class="muted scan-when" title={formatDateTime(s.at)}>
          {s.trigger === "scheduled"
            ? "scheduled, "
            : s.trigger === "cli"
              ? "hirehound scan, "
              : ""}
          {age(s.at)} ago
        </span>
      </button>
      {open ? (
        <div class="scan-detail">
          {s.added.length ? (
            <div>
              <h4>Added</h4>
              <ul>
                {s.added.map((a) => (
                  <li key={a.id}>
                    {known.has(a.id) ? <Link href={jobPath(a.id)}>{a.title}</Link> : a.title}
                    {a.repostOf ? (
                      <span class="badge warning" title={`Like ${a.repostOf}`}>
                        Repost
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {s.filtered.length ? (
            <div>
              <h4>Filtered</h4>
              <ul>
                {s.filtered.map((f) => (
                  <li key={f.ref}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer">
                      {f.title}
                    </a>
                    {f.location ? <span class="muted"> . {f.location}</span> : null}
                    <div class="muted small-print">{f.reason}</div>
                    {s.source !== "linkedin-email" ? (
                      <button
                        type="button"
                        class="btn small ghost"
                        onClick={() => props.onAdd(s.source, f.ref)}
                      >
                        Add anyway
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {s.gone.length ? (
            <div>
              <h4>No longer listed</h4>
              <ul>
                {s.gone.map((g) => (
                  <li key={g.id}>
                    {known.has(g.id) ? <Link href={jobPath(g.id)}>{g.title}</Link> : g.title}
                    {g.expired ? (
                      <span class="badge">Expired</span>
                    ) : (
                      <span class="badge warning">Flagged</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {s.back.length ? (
            <div>
              <h4>Listed again</h4>
              <ul>
                {s.back.map((b) => (
                  <li key={b.id}>
                    {known.has(b.id) ? <Link href={jobPath(b.id)}>{b.title}</Link> : b.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function AlertImport() {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
  };
  return (
    <section class="card">
      <header class="card-header">
        <h2>LinkedIn job alerts</h2>
      </header>
      <div class="card-body sources-alert">
        <p class="secondary">
          Save a LinkedIn job-alert email as a file (.eml) and drop it here, or paste its text. Each
          job becomes a Found job. Hirehound opens each public job page once, like a signed-out
          visitor; when LinkedIn refuses, the job waits for you to paste its text. It never signs
          in.
        </p>
        <label
          class="dropzone"
          data-dragging={dragging ? "true" : undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void load(e.dataTransfer?.files[0]);
          }}
        >
          <Icon name="note" />
          <span>
            {text ? "Email loaded. Import it, or drop another." : "Drop an .eml file or choose one"}
          </span>
          <input
            ref={file}
            type="file"
            accept=".eml,message/rfc822,text/plain"
            class="visually-hidden"
            onChange={(e) => void load(e.currentTarget.files?.[0])}
          />
        </label>
        <textarea
          class="textarea"
          rows={4}
          aria-label="Alert email text"
          placeholder="...or paste the alert email here"
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <div>
          <button
            type="button"
            class="btn primary"
            disabled={text.trim().length < 20}
            onClick={async () => {
              try {
                await api.importAlert(text);
                setText("");
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            }}
          >
            Import the jobs
          </button>
        </div>
      </div>
    </section>
  );
}

export function SourcesScreen(props: ScreenProps) {
  const [view, setView] = useState<SourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const task = useDiscoveryTask();
  const running = task?.state === "running";

  const reload = () =>
    api.sources().then(
      (v) => {
        setView(v);
        setError(null);
      },
      (e) => setError(errorMessage(e)),
    );
  useEffect(() => {
    void reload();
  }, [task?.state, task?.id]);

  const save = async (portals: Portal[], everyHours?: number) => {
    if (!view) return;
    try {
      const next = await api.saveSources(
        {
          version: 1,
          schedule: { every_hours: everyHours ?? view.everyHours },
          portals: portals.map(
            ({
              id,
              company,
              provider,
              board,
              region,
              titles,
              exclude_titles,
              locations,
              enabled,
            }) => ({
              id,
              company,
              provider,
              board,
              region,
              titles,
              exclude_titles,
              locations,
              enabled,
            }),
          ),
        },
        view.file.sha256,
      );
      setView(next);
      setEditing(null);
    } catch (e) {
      toast(errorMessage(e), "error");
      void reload();
    }
  };

  const scan = (ids?: string[]) =>
    api.scan(ids ? { portals: ids } : {}).catch((e) => toast(errorMessage(e), "error"));

  const names = new Map(view?.portals.map((p) => [p.id, p.company]) ?? []);
  const portals = view?.portals ?? [];

  return (
    <>
      {props.frame(
        "Sources",
        <button
          type="button"
          class="btn primary"
          disabled={running || !portals.some((p) => p.enabled)}
          onClick={() => void scan()}
        >
          <Icon name="sources" size={14} /> Scan now
        </button>,
      )}
      <div class="content">
        <div class="page sources">
          {error ? <Notice kind="danger">{error}</Notice> : null}
          {view?.file.diagnostics.length ? (
            <Notice kind="warning">
              sources/portals.yaml: {view.file.diagnostics[0]?.message}
            </Notice>
          ) : null}
          {task && task.state !== "done" ? <TaskStatus task={task} /> : null}

          <section class="card">
            <header class="card-header">
              <h2>Job boards ({portals.length})</h2>
              <div class="actions">
                <label class="toggle small-print">
                  Scan every{" "}
                  <select
                    class="select"
                    aria-label="Scan schedule"
                    value={String(view?.everyHours ?? 12)}
                    onChange={(e) => void save(portals, Number(e.currentTarget.value))}
                  >
                    {SCHEDULES.map((h) => (
                      <option key={h} value={h}>
                        {h === 0 ? "never (manual only)" : `${h} hours`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </header>
            <div class="card-body sources-meta muted small-print">
              {view?.lastScanAt ? `Last scan ${age(view.lastScanAt)} ago. ` : "Not scanned yet. "}
              {view?.nextScanAt
                ? `Next ${Date.parse(view.nextScanAt) <= Date.now() ? "within a minute" : `at ${formatDateTime(view.nextScanAt)}`}, while Hirehound is open.`
                : "Scheduled scans are off."}{" "}
              With Hirehound closed, run <code>hirehound scan</code> from cron or Task Scheduler.
            </div>
            {portals.length === 0 && editing !== "new" ? (
              <EmptyState
                icon="sources"
                title="No job boards yet"
                compact
                actions={
                  <button type="button" class="btn primary" onClick={() => setEditing("new")}>
                    Add a job board
                  </button>
                }
              >
                Watch companies that hire through Greenhouse, Lever or Ashby. Scans add new postings
                as Found jobs, filtered by your preferences; you decide what to evaluate.
              </EmptyState>
            ) : null}
            <ul class="portal-list">
              {portals.map((p) =>
                editing === p.id ? (
                  <li key={p.id}>
                    <PortalForm
                      initial={p}
                      onCancel={() => setEditing(null)}
                      onSave={(next) =>
                        save(portals.map((x) => (x.id === p.id ? { ...x, ...next, id: p.id } : x)))
                      }
                    />
                  </li>
                ) : (
                  <li key={p.id} class="portal-row" data-enabled={p.enabled ? "true" : "false"}>
                    <div class="portal-main">
                      <div class="portal-title">
                        <strong>{p.company}</strong>
                        <span class="badge">{PROVIDER[p.provider]}</span>
                        <a
                          class="muted small-print"
                          href={boardPage(p)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {p.board} <Icon name="external" size={10} />
                        </a>
                        {!p.enabled ? <span class="badge">Paused</span> : null}
                      </div>
                      <div class="muted small-print">
                        {p.titles.length ? `Titles: ${p.titles.join(", ")}` : "All titles"}
                        {p.exclude_titles.length ? `, not ${p.exclude_titles.join(", ")}` : ""}
                        {" . "}
                        {p.locations.length ? `Locations: ${p.locations.join(", ")}` : "Anywhere"}
                      </div>
                      {p.lastScan ? (
                        <div class="small-print">
                          <ScanCounts scan={p.lastScan} />{" "}
                          <span class="muted">{age(p.lastScan.at)} ago</span>
                        </div>
                      ) : null}
                    </div>
                    <div class="portal-actions">
                      <button
                        type="button"
                        class="btn small"
                        disabled={running}
                        onClick={() => void scan([p.id])}
                      >
                        Scan
                      </button>
                      <button
                        type="button"
                        class="btn small ghost"
                        onClick={() => setEditing(p.id)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="btn small ghost"
                        onClick={() =>
                          void save(
                            portals.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)),
                          )
                        }
                      >
                        {p.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        class="btn small ghost icon"
                        aria-label={`Remove ${p.company}`}
                        onClick={() => void save(portals.filter((x) => x.id !== p.id))}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </li>
                ),
              )}
            </ul>
            {editing === "new" ? (
              <div class="card-body">
                <PortalForm
                  onCancel={() => setEditing(null)}
                  onSave={async (next) => {
                    let id = slug(next.company);
                    for (let n = 2; portals.some((x) => x.id === id); n++)
                      id = `${slug(next.company).slice(0, 36)}-${n}`;
                    await save([...portals, { ...next, id } as Portal]);
                  }}
                />
              </div>
            ) : portals.length ? (
              <div class="card-body">
                <button type="button" class="btn small" onClick={() => setEditing("new")}>
                  <Icon name="plus" size={12} /> Add a job board
                </button>
              </div>
            ) : null}
          </section>

          <section class="card">
            <header class="card-header">
              <h2>Recent scans</h2>
            </header>
            {view?.scans.length ? (
              <ul class="scan-list">
                {view.scans.slice(0, 20).map((s) => (
                  <ScanRow
                    key={`${s.at}-${s.source}`}
                    scan={s}
                    name={
                      s.source === "linkedin-email"
                        ? "LinkedIn alert"
                        : (names.get(s.source) ?? s.source)
                    }
                    onAdd={async (source, ref) => {
                      try {
                        const added = await api.addFiltered({ source, ref });
                        toast(`Added: ${added.summary.title}`, "success");
                      } catch (e) {
                        toast(errorMessage(e), "error");
                      }
                    }}
                  />
                ))}
              </ul>
            ) : (
              <div class="card-body muted">No scans yet.</div>
            )}
          </section>

          <AlertImport />
        </div>
      </div>
    </>
  );
}
