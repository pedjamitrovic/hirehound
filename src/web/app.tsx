import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { AddJobDialog } from "./components/AddJobDialog.tsx";
import { Icon } from "./components/Icon.tsx";
import { MoveDialog } from "./components/MoveDialog.tsx";
import { Sidebar, TopBar } from "./components/Shell.tsx";
import { ShortcutSheet } from "./components/ShortcutSheet.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { EmptyState } from "./components/ui.tsx";
import { useHotkeys } from "./hotkeys.ts";
import { navigate, type Route, route } from "./router.ts";
import { JobScreen } from "./screens/Job.tsx";
import { OnboardingScreen } from "./screens/Onboarding.tsx";
import { PipelineScreen } from "./screens/Pipeline.tsx";
import { Placeholder } from "./screens/Placeholder.tsx";
import { ProfileScreen } from "./screens/Profile.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";
import { SourcesScreen } from "./screens/Sources.tsx";
import { TodayScreen } from "./screens/Today.tsx";
import { addJobOpen, moveRequest } from "./state/actions.ts";
import { loadError, loaded, refresh, startSync } from "./state/store.ts";

export const helpOpen = signal(false);

export type ScreenProps = {
  /** Renders the top bar with screen-specific title and actions. */
  frame: (title: ComponentChildren, actions?: ComponentChildren) => ComponentChildren;
};

const TITLES: Record<Route["name"], string> = {
  today: "Today",
  pipeline: "Pipeline",
  job: "Job",
  profile: "Profile",
  sources: "Sources",
  insights: "Insights",
  onboarding: "Onboarding",
  settings: "Settings",
  "not-found": "Not found",
};

function Screen(props: { route: Route } & ScreenProps) {
  const r = props.route;
  switch (r.name) {
    case "today":
      return <TodayScreen frame={props.frame} />;
    case "pipeline":
      return <PipelineScreen frame={props.frame} />;
    case "settings":
      return <SettingsScreen frame={props.frame} />;
    case "profile":
      return <ProfileScreen frame={props.frame} tab={r.tab} baseId={r.baseId} />;
    case "onboarding":
      return <OnboardingScreen frame={props.frame} />;
    case "sources":
      return <SourcesScreen frame={props.frame} />;
    case "insights":
      return (
        <Placeholder
          frame={props.frame}
          title="Insights"
          icon="insights"
          milestone="M6"
          text="Your funnel by base profile, source and score band, plus calibration suggestions."
        />
      );
    case "job":
      return <JobScreen key={r.id} frame={props.frame} id={r.id} tab={r.tab} />;
    case "not-found":
      return (
        <>
          {props.frame("Not found")}
          <div class="content">
            <EmptyState
              icon="alert"
              title="Nothing here"
              actions={
                <button type="button" class="btn" onClick={() => navigate("/")}>
                  Go to Today
                </button>
              }
            >
              There is no page at {r.path}.
            </EmptyState>
          </div>
        </>
      );
  }
}

export function App() {
  useEffect(() => startSync(), []);

  useHotkeys([
    {
      keys: "?",
      group: "General",
      description: "Show keyboard shortcuts",
      run: () => {
        helpOpen.value = true;
      },
    },
    {
      keys: "n",
      group: "General",
      description: "Add a job",
      run: () => {
        addJobOpen.value = true;
      },
    },
    { keys: "g t", group: "Go to", description: "Today", run: () => navigate("/") },
    { keys: "g p", group: "Go to", description: "Pipeline", run: () => navigate("/pipeline") },
    { keys: "g s", group: "Go to", description: "Settings", run: () => navigate("/settings") },
  ]);

  const current = route.value;
  useEffect(() => {
    document.title = `${TITLES[current.name]} - Hirehound`;
  }, [current.name]);

  const frame: ScreenProps["frame"] = (title, actions) => (
    <TopBar
      title={title}
      actions={actions}
      onHelp={() => {
        helpOpen.value = true;
      }}
    />
  );

  let body: ComponentChildren;
  if (!loaded.value) {
    body = (
      <>
        {frame(TITLES[current.name])}
        <div class="content">
          {loadError.value ? (
            <EmptyState
              icon="alert"
              title="Cannot load the workspace"
              actions={
                <button type="button" class="btn" onClick={() => void refresh()}>
                  Try again
                </button>
              }
            >
              {loadError.value}
            </EmptyState>
          ) : (
            <div class="empty compact muted">
              <Icon name="pipeline" /> Loading workspace...
            </div>
          )}
        </div>
      </>
    );
  } else {
    body = <Screen route={current} frame={frame} />;
  }

  return (
    <div class="shell">
      <Sidebar />
      <main class="main">{body}</main>
      {helpOpen.value ? (
        <ShortcutSheet
          onClose={() => {
            helpOpen.value = false;
          }}
        />
      ) : null}
      {addJobOpen.value ? (
        <AddJobDialog
          onClose={() => {
            addJobOpen.value = false;
          }}
        />
      ) : null}
      {moveRequest.value ? (
        <MoveDialog
          request={moveRequest.value}
          onClose={() => {
            moveRequest.value = null;
          }}
        />
      ) : null}
      <Toasts />
    </div>
  );
}
