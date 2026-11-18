import { computed, signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { JobSummary } from "../../shared/schemas/api.ts";
import type { PostingSource } from "../../shared/schemas/posting.ts";
import type { JobState } from "../../shared/schemas/status.ts";
import {
  CLOSED_STATES,
  isClosed,
  PIPELINE,
  requiresReason,
  STATE_LABELS,
} from "../../shared/states.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { age, EmptyState, formatDate, Link, Score, StateBadge } from "../components/ui.tsx";
import { useHotkeys } from "../hotkeys.ts";
import { jobPath, navigate, searchParams, setSearchParams } from "../router.ts";
import { addJobOpen, moveJob, openMove, optionFor } from "../state/actions.ts";
import { jobList } from "../state/store.ts";
import { toast } from "../state/toasts.ts";

type View = "board" | "table";
type SortKey = "score" | "company" | "title" | "state" | "source" | "added" | "updated";

const SOURCE_LABELS: Record<PostingSource, string> = {
  "manual-url": "Link",
  "manual-text": "Pasted",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  workable: "Workable",
  smartrecruiters: "SmartRecruiters",
  "linkedin-email": "LinkedIn alert",
  browser: "Browser",
};

const STATE_ORDER = [...PIPELINE, ...CLOSED_STATES] as JobState[];

/** Selection lives outside the component so it survives view switches and SSE updates. */
const selectedId = signal<string | null>(null);
const checked = signal<ReadonlySet<string>>(new Set());
const dragging = signal<JobSummary | null>(null);

const view = computed<View>(() => (searchParams.value.get("view") === "table" ? "table" : "board"));
const showClosed = computed(() => searchParams.value.get("closed") === "1");
const query = computed(() => searchParams.value.get("q") ?? "");
const stateFilter = computed(
  () => new Set((searchParams.value.get("state") ?? "").split(",").filter(Boolean)),
);
const sourceFilter = computed(() => searchParams.value.get("source") ?? "");
const sortKey = computed<SortKey>(() => (searchParams.value.get("sort") as SortKey) || "updated");
const sortDir = computed(() => (searchParams.value.get("dir") === "asc" ? 1 : -1));

const filtered = computed(() => {
  const terms = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  return jobList.value.filter((job) => {
    if (!showClosed.value && view.value === "board" && isClosed(job.state)) return false;
    if (stateFilter.value.size && !stateFilter.value.has(job.state)) return false;
    if (sourceFilter.value && job.source !== sourceFilter.value) return false;
    if (terms.length) {
      const haystack = `${job.company} ${job.title} ${job.location ?? ""}`.toLowerCase();
      if (!terms.every((t) => haystack.includes(t))) return false;
    }
    return true;
  });
});

const sorted = computed(() => {
  const key = sortKey.value;
  const dir = sortDir.value;
  const value = (job: JobSummary): string | number => {
    switch (key) {
      case "score":
        return job.score ?? -1;
      case "company":
        return job.company.toLowerCase();
      case "title":
        return job.title.toLowerCase();
      case "state":
        return STATE_ORDER.indexOf(job.state);
      case "source":
        return job.source ?? "";
      case "added":
        return job.addedAt;
      case "updated":
        return job.updatedAt;
    }
  };
  return [...filtered.value].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir || a.company.localeCompare(b.company);
  });
});

/** Board columns in pipeline order, plus "Closed" when shown. */
const columns = computed(() => {
  const states: (JobState | "closed")[] = [...PIPELINE];
  if (showClosed.value) states.push("closed");
  return states.map((state) => ({
    state,
    jobs: filtered.value
      .filter((j) => (state === "closed" ? isClosed(j.state) : j.state === state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
});

function visibleOrder(): JobSummary[] {
  return view.value === "table" ? sorted.value : columns.value.flatMap((c) => c.jobs);
}

function selectedJob(): JobSummary | undefined {
  return visibleOrder().find((j) => j.id === selectedId.value);
}

function toggleChecked(id: string): void {
  const next = new Set(checked.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  checked.value = next;
}

/** Drop / keyboard move: run directly, or ask for a reason first. */
function requestMove(job: JobSummary, to: JobState): void {
  const option = optionFor(job, to);
  if (!option) {
    toast(
      `${job.company} cannot move from ${STATE_LABELS[job.state]} to ${STATE_LABELS[to]}.`,
      "error",
    );
    return;
  }
  if (!option.allowed) {
    toast(option.message ?? "That move is not possible right now.", "error");
    return;
  }
  if (option.needsReason || requiresReason(option.to, option.method)) {
    openMove([job], { to: option.to, ...(option.method ? { method: option.method } : {}) });
    return;
  }
  void moveJob(job, option);
}

function moveAlongPipeline(job: JobSummary, direction: 1 | -1): void {
  const index = (PIPELINE as readonly JobState[]).indexOf(job.state);
  const target = PIPELINE[index + direction];
  if (index < 0 || !target) return;
  requestMove(job, target);
}

function scrollIntoView(id: string | null): void {
  if (!id) return;
  requestAnimationFrame(() => {
    document
      .querySelector(`[data-job="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function Card(props: { job: JobSummary }) {
  const { job } = props;
  const selected = selectedId.value === job.id;
  return (
    <Link
      href={jobPath(job.id)}
      class="job-card"
      data-job={job.id}
      aria-current={selected ? "true" : undefined}
      data-checked={checked.value.has(job.id) ? "true" : undefined}
      draggable
      onDragStart={(e) => {
        dragging.value = job;
        selectedId.value = job.id;
        e.dataTransfer?.setData("text/plain", job.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dragging.value = null;
      }}
      onFocus={() => {
        selectedId.value = job.id;
      }}
    >
      <span class="job-card-company truncate">{job.company}</span>
      <span class="job-card-title">{job.title}</span>
      <span class="job-card-meta">
        <Score score={job.score} band={job.band} />
        {isClosed(job.state) ? <StateBadge state={job.state} /> : null}
        {job.appliedExternally ? <span class="badge">external</span> : null}
        {job.errors ? (
          <span class="badge danger" title="Has file problems">
            <Icon name="alert" size={12} />
          </span>
        ) : null}
        <span class="muted num" style={{ marginLeft: "auto" }} title={job.updatedAt}>
          {age(job.updatedAt)}
        </span>
      </span>
    </Link>
  );
}

function Column(props: { state: JobState | "closed"; jobs: JobSummary[] }) {
  const { state, jobs } = props;
  const drag = dragging.value;
  const dropOption =
    drag && state !== "closed" && drag.state !== state ? optionFor(drag, state) : undefined;
  const canDrop = Boolean(dropOption?.allowed);
  const dimmed = drag !== null && state !== "closed" && drag.state !== state && !canDrop;
  return (
    <section
      class="board-column"
      data-state={state === "closed" ? "skipped" : state}
      data-drop={canDrop ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      title={
        dimmed
          ? (dropOption?.message ?? `Cannot move here from ${STATE_LABELS[drag.state]}`)
          : undefined
      }
      onDragOver={(e) => {
        if (!canDrop) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const job = dragging.value;
        dragging.value = null;
        if (job && state !== "closed" && canDrop) requestMove(job, state);
      }}
    >
      <header class="board-column-header">
        <span class="state-dot" />
        {state === "closed" ? "Closed" : STATE_LABELS[state]}
        <span class="count">{jobs.length}</span>
      </header>
      <div class="board-column-body">
        {jobs.map((job) => (
          <Card key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}

function Board() {
  return (
    <div class="board">
      {columns.value.map((column) => (
        <Column key={column.state} state={column.state} jobs={column.jobs} />
      ))}
    </div>
  );
}

const SORTABLE: { key: SortKey; label: string; class?: string }[] = [
  { key: "score", label: "Score", class: "col-score" },
  { key: "company", label: "Company" },
  { key: "title", label: "Role" },
  { key: "state", label: "State" },
  { key: "source", label: "Source" },
  { key: "added", label: "Added" },
  { key: "updated", label: "Updated" },
];

function Table() {
  const rows = sorted.value;
  const allChecked = rows.length > 0 && rows.every((r) => checked.value.has(r.id));
  return (
    <table class="table">
      <thead>
        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allChecked}
              onChange={() => {
                checked.value = allChecked ? new Set() : new Set(rows.map((r) => r.id));
              }}
            />
          </th>
          {SORTABLE.map((col) => {
            const active = sortKey.value === col.key;
            return (
              <th
                key={col.key}
                class={col.class}
                aria-sort={active ? (sortDir.value === 1 ? "ascending" : "descending") : undefined}
              >
                <button
                  type="button"
                  onClick={() =>
                    setSearchParams({
                      sort: col.key,
                      dir: active && sortDir.value === -1 ? "asc" : "desc",
                    })
                  }
                >
                  {col.label}
                  {active ? (
                    <Icon name="chevronDown" size={12} class={sortDir.value === 1 ? "flip" : ""} />
                  ) : null}
                </button>
              </th>
            );
          })}
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((job) => (
          <tr
            key={job.id}
            data-job={job.id}
            aria-selected={selectedId.value === job.id}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a, input, button")) return;
              selectedId.value = job.id;
            }}
            onDblClick={() => navigate(jobPath(job.id))}
          >
            <td class="col-check">
              <input
                type="checkbox"
                aria-label={`Select ${job.company}`}
                checked={checked.value.has(job.id)}
                onChange={() => toggleChecked(job.id)}
              />
            </td>
            <td class="col-score">
              <Score score={job.score} band={job.band} />
            </td>
            <td class="truncate">
              <Link href={jobPath(job.id)} class="strong-link">
                {job.company}
              </Link>
            </td>
            <td class="truncate" title={job.title}>
              {job.title}
            </td>
            <td>
              <StateBadge state={job.state} external={job.appliedExternally} />
            </td>
            <td class="secondary">{job.source ? SOURCE_LABELS[job.source] : "-"}</td>
            <td class="secondary num">{formatDate(job.addedAt)}</td>
            <td class="secondary num" title={job.updatedAt}>
              {age(job.updatedAt)}
            </td>
            <td class="secondary truncate">{job.location ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StateFilter() {
  const active = stateFilter.value;
  return (
    <details class="filter-menu">
      <summary class="btn small">
        State{active.size ? `: ${active.size}` : ""}
        <Icon name="chevronDown" size={12} />
      </summary>
      <div class="menu">
        {STATE_ORDER.map((state) => (
          <label key={state} class="menu-check" data-state={state}>
            <input
              type="checkbox"
              checked={active.has(state)}
              onChange={() => {
                const next = new Set(active);
                if (next.has(state)) next.delete(state);
                else next.add(state);
                setSearchParams({ state: [...next].join(",") || null });
              }}
            />
            <span class="state-dot" />
            {STATE_LABELS[state]}
          </label>
        ))}
        {active.size ? (
          <button type="button" onClick={() => setSearchParams({ state: null })}>
            Clear
          </button>
        ) : null}
      </div>
    </details>
  );
}

function Toolbar() {
  const sources = [
    ...new Set(jobList.value.map((j) => j.source).filter(Boolean)),
  ] as PostingSource[];
  const count = checked.value.size;
  const selectedJobs = () => jobList.value.filter((j) => checked.value.has(j.id));
  return (
    <div class="toolbar">
      <fieldset class="btn-group">
        <legend class="visually-hidden">View</legend>
        <button
          type="button"
          class="btn small"
          aria-pressed={view.value === "board"}
          onClick={() => setSearchParams({ view: null })}
        >
          <Icon name="board" size={14} /> Board
        </button>
        <button
          type="button"
          class="btn small"
          aria-pressed={view.value === "table"}
          onClick={() => setSearchParams({ view: "table" })}
        >
          <Icon name="table" size={14} /> Table
        </button>
      </fieldset>
      <input
        class="input filter-input"
        type="search"
        placeholder="Filter by company, role or location"
        aria-label="Filter jobs"
        value={query.value}
        onInput={(e) => setSearchParams({ q: e.currentTarget.value })}
      />
      <StateFilter />
      {sources.length > 1 ? (
        <select
          class="select filter-select"
          aria-label="Source"
          value={sourceFilter.value}
          onChange={(e) => setSearchParams({ source: e.currentTarget.value })}
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      ) : null}
      {view.value === "board" ? (
        <label class="toggle">
          <input
            type="checkbox"
            checked={showClosed.value}
            onChange={(e) => setSearchParams({ closed: e.currentTarget.checked ? "1" : null })}
          />
          Show closed
        </label>
      ) : null}
      <span class="muted num" style={{ marginLeft: "auto" }}>
        {filtered.value.length} of {jobList.value.length} jobs
      </span>
      {count > 0 ? (
        <div class="bulk-bar">
          <span>{count} selected</span>
          <button type="button" class="btn small" onClick={() => openMove(selectedJobs())}>
            Move to... <kbd>M</kbd>
          </button>
          <button
            type="button"
            class="btn small"
            onClick={() => openMove(selectedJobs(), { to: "skipped" })}
          >
            Skip
          </button>
          <button
            type="button"
            class="btn ghost small"
            onClick={() => {
              checked.value = new Set();
            }}
          >
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

function moveSelection(delta: number): void {
  const order = visibleOrder();
  if (order.length === 0) return;
  const index = order.findIndex((j) => j.id === selectedId.value);
  const next = order[index < 0 ? 0 : Math.max(0, Math.min(order.length - 1, index + delta))];
  selectedId.value = next?.id ?? null;
  scrollIntoView(selectedId.value);
}

function moveColumn(delta: 1 | -1): void {
  const cols = columns.value.filter((c) => c.jobs.length > 0);
  if (cols.length === 0) return;
  const current = cols.findIndex((c) => c.jobs.some((j) => j.id === selectedId.value));
  const row =
    current >= 0 ? (cols[current]?.jobs.findIndex((j) => j.id === selectedId.value) ?? 0) : 0;
  const target = cols[current < 0 ? 0 : Math.max(0, Math.min(cols.length - 1, current + delta))];
  const job = target?.jobs[Math.min(row, target.jobs.length - 1)];
  selectedId.value = job?.id ?? null;
  scrollIntoView(selectedId.value);
}

export function PipelineScreen(props: ScreenProps) {
  const container = useRef<HTMLDivElement>(null);

  // Keep the selection valid as jobs come and go.
  useEffect(() => {
    if (selectedId.value && !visibleOrder().some((j) => j.id === selectedId.value)) {
      selectedId.value = null;
    }
  });

  useHotkeys([
    {
      keys: "b",
      group: "Pipeline",
      description: "Board view",
      run: () => setSearchParams({ view: null }),
    },
    {
      keys: "t",
      group: "Pipeline",
      description: "Table view",
      run: () => setSearchParams({ view: "table" }),
    },
    { keys: "j", group: "Pipeline", description: "Next job", run: () => moveSelection(1) },
    { keys: "k", group: "Pipeline", description: "Previous job", run: () => moveSelection(-1) },
    {
      keys: "arrowdown",
      group: "Pipeline",
      description: "Next job",
      run: () => moveSelection(1),
      hidden: true,
    },
    {
      keys: "arrowup",
      group: "Pipeline",
      description: "Previous job",
      run: () => moveSelection(-1),
      hidden: true,
    },
    {
      keys: "h",
      group: "Pipeline",
      description: "Previous column",
      run: () => moveColumn(-1),
      enabled: () => view.value === "board",
    },
    {
      keys: "l",
      group: "Pipeline",
      description: "Next column",
      run: () => moveColumn(1),
      enabled: () => view.value === "board",
    },
    {
      keys: "arrowleft",
      group: "Pipeline",
      description: "Previous column",
      run: () => moveColumn(-1),
      hidden: true,
      enabled: () => view.value === "board",
    },
    {
      keys: "arrowright",
      group: "Pipeline",
      description: "Next column",
      run: () => moveColumn(1),
      hidden: true,
      enabled: () => view.value === "board",
    },
    {
      keys: "enter",
      group: "Pipeline",
      description: "Open job",
      run: () => {
        const job = selectedJob();
        if (job) navigate(jobPath(job.id));
      },
    },
    {
      keys: "x",
      group: "Pipeline",
      description: "Select for bulk actions",
      run: () => {
        if (selectedId.value) toggleChecked(selectedId.value);
      },
    },
    {
      keys: "m",
      group: "Pipeline",
      description: "Move to...",
      run: () => {
        const bulk = jobList.value.filter((j) => checked.value.has(j.id));
        const job = selectedJob();
        openMove(bulk.length ? bulk : job ? [job] : []);
      },
    },
    {
      keys: "]",
      group: "Pipeline",
      description: "Move forward",
      run: () => {
        const job = selectedJob();
        if (job) moveAlongPipeline(job, 1);
      },
    },
    {
      keys: "[",
      group: "Pipeline",
      description: "Move back",
      run: () => {
        const job = selectedJob();
        if (job) moveAlongPipeline(job, -1);
      },
    },
    {
      keys: "s",
      group: "Pipeline",
      description: "Skip",
      run: () => {
        const job = selectedJob();
        if (job) requestMove(job, "skipped");
      },
    },
    {
      keys: "escape",
      group: "Pipeline",
      description: "Clear selection",
      hidden: true,
      run: () => {
        checked.value = new Set();
        selectedId.value = null;
      },
    },
  ]);

  const total = jobList.value.length;

  return (
    <>
      {props.frame("Pipeline")}
      <div class="content pipeline" ref={container}>
        {total === 0 ? (
          <EmptyState
            icon="pipeline"
            title="No jobs yet"
            actions={
              <button
                type="button"
                class="btn primary"
                onClick={() => {
                  addJobOpen.value = true;
                }}
              >
                <Icon name="plus" size={14} /> Add a job <kbd>N</kbd>
              </button>
            }
          >
            Add a posting by link or pasted text. It lands in Found, and you move it along as you
            go.
          </EmptyState>
        ) : (
          <>
            <Toolbar />
            {filtered.value.length === 0 && view.value === "table" ? (
              <EmptyState icon="search" title="No jobs match these filters" compact>
                <button
                  type="button"
                  class="btn small"
                  onClick={() => setSearchParams({ q: null, state: null, source: null })}
                >
                  Clear filters
                </button>
              </EmptyState>
            ) : view.value === "board" ? (
              <Board />
            ) : (
              <div class="table-wrap">
                <Table />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
