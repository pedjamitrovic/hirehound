import type { ComponentChildren } from "preact";
import type { JobSummary, ProfileFileState } from "../../shared/schemas/api.ts";
import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { age, EmptyState, Link, Score, StateBadge } from "../components/ui.tsx";
import { jobPath } from "../router.ts";
import { addJobOpen } from "../state/actions.ts";
import { jobList, workspace } from "../state/store.ts";

const HEADING = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function JobRows(props: { jobs: JobSummary[]; empty: string }) {
  if (props.jobs.length === 0) {
    return <div class="card-body muted">{props.empty}</div>;
  }
  return (
    <ul class="list">
      {props.jobs.map((job) => (
        <li key={job.id}>
          <Link class="list-row" href={jobPath(job.id)}>
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

const PROFILE_LABELS: Record<"contact" | "preferences" | "answers", string> = {
  contact: "Contact details",
  preferences: "Preferences",
  answers: "Saved answers",
};

function stateText(state: ProfileFileState): string {
  return state === "ok" ? "Done" : state === "missing" ? "Not set up" : "Has errors";
}

function ProfileSetup() {
  const info = workspace.value;
  if (!info) return null;
  const files = (["contact", "preferences", "answers"] as const).map((key) => ({
    key,
    state: info.profile[key],
  }));
  if (files.every((f) => f.state === "ok") && info.profile.bases.length > 0) return null;
  return (
    <Section title="Set up your profile">
      <div class="card-body" style={{ display: "grid", gap: "8px" }}>
        <p class="secondary">
          The onboarding wizard arrives in M2. Until then you can fill in these files in your
          workspace; changes show up here instantly.
        </p>
        <ul class="list">
          {files.map((f) => (
            <li key={f.key} class="list-row" style={{ paddingInline: 0 }}>
              <Icon name={f.state === "ok" ? "check" : "info"} size={14} />
              <span>{PROFILE_LABELS[f.key]}</span>
              <code class="muted">profile/{f.key}.yaml</code>
              <span class="meta">
                <span
                  class={`badge ${f.state === "ok" ? "success" : f.state === "invalid" ? "danger" : ""}`}
                >
                  {stateText(f.state)}
                </span>
              </span>
            </li>
          ))}
          <li class="list-row" style={{ paddingInline: 0 }}>
            <Icon name={info.profile.bases.length ? "check" : "info"} size={14} />
            <span>Base CVs</span>
            <code class="muted">profile/bases/*.md</code>
            <span class="meta">
              <span class={`badge ${info.profile.bases.length ? "success" : ""}`}>
                {info.profile.bases.length ? `${info.profile.bases.length} found` : "M2"}
              </span>
            </span>
          </li>
        </ul>
      </div>
    </Section>
  );
}

export function TodayScreen(props: ScreenProps) {
  const all = jobList.value;
  const toEvaluate = all.filter((j) => j.state === "found");
  const toReview = all.filter((j) => j.state === "ready");
  const inProgress = all.filter((j) => ["evaluated", "tailoring", "approved"].includes(j.state));
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
                <Section title="Needs your review" count={toReview.length}>
                  <JobRows jobs={toReview} empty="" />
                </Section>
              ) : null}
              <Section title="To evaluate" count={toEvaluate.length}>
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
