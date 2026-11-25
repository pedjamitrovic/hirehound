import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { JobSummary, ProfileFileState, SourcesView } from "../../shared/schemas/api.ts";
import { api, errorMessage } from "../api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { useAiReady } from "../components/TaskStatus.tsx";
import { age, EmptyState, Link, Score, StateBadge } from "../components/ui.tsx";
import { jobPath, type TabId } from "../router.ts";
import { addJobOpen } from "../state/actions.ts";
import { jobList, runningTasks, workspace } from "../state/store.ts";
import { toast } from "../state/toasts.ts";

const HEADING = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** Starts an evaluation for every job in the list; the task runner works through them a few at a time. */
function EvaluateAll(props: { jobs: JobSummary[] }) {
  const aiReady = useAiReady();
  const running = runningTasks.value.some((t) => t.kind === "evaluate");
  return (
    <button
      type="button"
      class="btn small"
      disabled={aiReady === false || running}
      title={aiReady === false ? "Set up Claude in Settings first" : undefined}
      onClick={async () => {
        let started = 0;
        for (const job of props.jobs) {
          try {
            await api.evaluate(job.id);
            started++;
          } catch (e) {
            toast(`${job.company}: ${errorMessage(e)}`, "error");
          }
        }
        if (started) toast(`Evaluating ${started} ${started === 1 ? "job" : "jobs"}`, "success");
      }}
    >
      {running
        ? "Evaluating..."
        : `Evaluate ${props.jobs.length === 1 ? "it" : `all ${props.jobs.length}`}`}
    </button>
  );
}

/** What the job board scans did in the last day, with a way to the details. */
function ScanSummary() {
  const [view, setView] = useState<SourcesView | null>(null);
  const running = runningTasks.value.some((t) => t.kind === "scan" || t.kind === "import-alert");
  useEffect(() => {
    api.sources().then(setView, () => setView(null));
  }, [running]);
  if (!view || (view.portals.length === 0 && view.scans.length === 0)) return null;
  const day = view.scans.filter((s) => Date.now() - Date.parse(s.at) < 86_400_000);
  const sum = (pick: (s: (typeof day)[number]) => number) => day.reduce((n, s) => n + pick(s), 0);
  const failed = day.filter((s) => !s.ok).length;
  return (
    <Section title="From your job boards" action={<Link href="/sources">Open Sources</Link>}>
      <div class="card-body secondary">
        {running
          ? "Scanning now..."
          : day.length
            ? `Last 24 hours: ${sum((s) => s.added.length)} added, ${sum((s) => s.filtered.length)} filtered, ${sum((s) => s.gone.length)} no longer listed${failed ? `, ${failed} boards could not be read` : ""}.`
            : "No scans in the last 24 hours."}{" "}
        {view.nextScanAt && !running ? (
          <span class="muted">
            Next scan{" "}
            {Date.parse(view.nextScanAt) <= Date.now()
              ? "soon"
              : `in about ${Math.max(1, Math.round((Date.parse(view.nextScanAt) - Date.now()) / 3_600_000))}h`}
            .
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function JobRows(props: { jobs: JobSummary[]; empty: string; tab?: TabId }) {
  if (props.jobs.length === 0) {
    return <div class="card-body muted">{props.empty}</div>;
  }
  return (
    <ul class="list">
      {props.jobs.map((job) => (
        <li key={job.id}>
          <Link class="list-row" href={jobPath(job.id, props.tab)}>
            <Score score={job.score} band={job.band} />
            <span class="company truncate">{job.company}</span>
            <span class="truncate secondary">{job.title}</span>
            <span class="meta">
              <StateBadge state={job.state} external={job.appliedExternally} />
              <span class="num" title={job.updatedAt}>
                {age(job.updatedAt)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Section(props: {
  title: string;
  count?: number;
  action?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="card">
      <header class="card-header">
        <h2>
          {props.title}
          {props.count !== undefined ? ` (${props.count})` : ""}
        </h2>
        {props.action ? <div class="actions">{props.action}</div> : null}
      </header>
      {props.children}
    </section>
  );
}

function stateText(state: ProfileFileState): string {
  return state === "ok" ? "Done" : state === "missing" ? "Not set up" : "Has errors";
}

function ProfileSetup() {
  const info = workspace.value;
  if (!info) return null;
  const { bank, bases } = info.profile;
  const items: { label: string; done: boolean; detail: string; href: string }[] = [
    {
      label: "Experience bank",
      done: bank.entries > 0 && bank.confirmed === bank.entries,
      detail:
        bank.entries === 0
          ? "Not started"
          : bank.confirmed === bank.entries
            ? `${bank.entries} entries, all confirmed`
            : `${bank.entries - bank.confirmed} of ${bank.entries} to review`,
      href: "/profile/experience",
    },
    {
      label: "Base CVs",
      done: bases.length >= 1,
      detail: bases.length ? `${bases.length} written` : "None yet",
      href: "/profile/bases",
    },
    {
      label: "Contact details",
      done: info.profile.contact === "ok",
      detail: stateText(info.profile.contact),
      href: "/profile/contact",
    },
    {
      label: "Preferences",
      done: info.profile.preferences === "ok",
      detail: stateText(info.profile.preferences),
      href: "/profile/preferences",
    },
  ];
  if (items.every((i) => i.done)) return null;
  return (
    <Section
      title="Set up your profile"
      action={
        <Link class="btn primary small" href="/onboarding">
          {bank.entries === 0 ? "Start onboarding" : "Continue onboarding"}
        </Link>
      }
    >
      <div class="card-body" style={{ display: "grid", gap: "8px" }}>
        <p class="secondary">
          Import your existing CVs and Claude drafts your experience bank: the facts every CV is
          built from. You review everything before it is used.
        </p>
        <ul class="list">
          {items.map((item) => (
            <li key={item.label}>
              <Link class="list-row" href={item.href} style={{ paddingInline: 0 }}>
                <Icon name={item.done ? "check" : "info"} size={14} />
                <span>{item.label}</span>
                <span class="meta">
                  <span class={`badge ${item.done ? "success" : ""}`}>{item.detail}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

export function TodayScreen(props: ScreenProps) {
  const all = jobList.value;
  const toEvaluate = all.filter((j) => j.state === "found");
  const toReview = all.filter((j) => j.state === "ready");
  const toApply = all.filter((j) => j.state === "approved");
  const inProgress = all.filter((j) => ["evaluated", "tailoring"].includes(j.state));
  const applications = all.filter((j) =>
    ["applied", "screening", "interviewing", "offer"].includes(j.state),
  );

  return (
    <>
      {props.frame(`Today, ${HEADING.format(new Date())}`)}
      <div class="content">
        <div class="page" style={{ display: "grid", gap: "16px", maxWidth: "960px" }}>
          {all.length === 0 ? (
            <section class="card">
              <EmptyState
                icon="pipeline"
                title="Your pipeline is empty"
                actions={
                  <button
                    type="button"
                    class="btn primary"
                    onClick={() => {
                      addJobOpen.value = true;
                    }}
                  >
                    <Icon name="plus" size={14} /> Add your first job <kbd>N</kbd>
                  </button>
                }
              >
                Jobs you add appear here when they need your attention: new postings to evaluate,
                tailored CVs to review, follow-ups and interviews.
              </EmptyState>
            </section>
          ) : (
            <>
              {toReview.length > 0 ? (
                <Section
                  title="Needs your review"
                  count={toReview.length}
                  action={
                    <Link class="btn primary small" href={jobPath(toReview[0]?.id ?? "", "cv")}>
                      Start reviewing
                    </Link>
                  }
                >
                  <JobRows jobs={toReview} empty="" tab="cv" />
                </Section>
              ) : null}
              {toApply.length > 0 ? (
                <Section title="Ready to apply" count={toApply.length}>
                  <JobRows jobs={toApply} empty="" tab="application" />
                </Section>
              ) : null}
              <ScanSummary />
              <Section
                title="To evaluate"
                count={toEvaluate.length}
                action={toEvaluate.length > 0 ? <EvaluateAll jobs={toEvaluate} /> : null}
              >
                <JobRows jobs={toEvaluate} empty="Nothing new. Add a job when you find one." />
              </Section>
              {inProgress.length > 0 ? (
                <Section title="In progress" count={inProgress.length}>
                  <JobRows jobs={inProgress} empty="" />
                </Section>
              ) : null}
              <Section
                title="Active applications"
                count={applications.length}
                action={<Link href="/pipeline">Open pipeline</Link>}
              >
                <JobRows jobs={applications.slice(0, 8)} empty="No applications yet." />
              </Section>
            </>
          )}
          <ProfileSetup />
        </div>
      </div>
    </>
  );
}
