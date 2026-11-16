import type { ComponentChildren } from "preact";
import { route } from "../router.ts";
import { addJobOpen } from "../state/actions.ts";
import { activeJobs, connection, jobList, workspace } from "../state/store.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { Search } from "./Search.tsx";
import { Link } from "./ui.tsx";

type NavEntry = { href: string; label: string; icon: IconName; match: string[] };

const NAV: NavEntry[] = [
  { href: "/", label: "Today", icon: "today", match: ["today"] },
  { href: "/pipeline", label: "Pipeline", icon: "pipeline", match: ["pipeline", "job"] },
  { href: "/profile", label: "Profile", icon: "profile", match: ["profile"] },
  { href: "/sources", label: "Sources", icon: "sources", match: ["sources"] },
  { href: "/insights", label: "Insights", icon: "insights", match: ["insights"] },
];

function NavItem(props: { entry: NavEntry; count?: number }) {
  const active = props.entry.match.includes(route.value.name);
  return (
    <Link class="nav-item" href={props.entry.href} aria-current={active ? "page" : undefined}>
      <Icon name={props.entry.icon} />
      {props.entry.label}
      {props.count ? <span class="count">{props.count}</span> : null}
    </Link>
  );
}

/** Jobs that need the user's attention: new ones to evaluate and CVs ready for review. */
export function attentionCount(): number {
  return jobList.value.filter((j) => j.state === "found" || j.state === "ready").length;
}

export function Sidebar() {
  const info = workspace.value;
  const state = connection.value;
  const settings: NavEntry = {
    href: "/settings",
    label: "Settings",
    icon: "settings",
    match: ["settings"],
  };
  const issues = info?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
  return (
    <nav class="sidebar" aria-label="Main">
      <Link class="brand" href="/" style={{ textDecoration: "none" }}>
        <span class="brand-mark" aria-hidden="true">
          H
        </span>
        Hirehound
      </Link>
      <div class="nav">
        {NAV.map((entry) => (
          <NavItem
            key={entry.href}
            entry={entry}
            count={
              entry.href === "/"
                ? attentionCount()
                : entry.href === "/pipeline"
                  ? activeJobs.value.length
                  : undefined
            }
          />
        ))}
      </div>
      <div class="sidebar-spacer" />
      <div class="nav">
        <NavItem entry={settings} count={issues || undefined} />
      </div>
      <div class="sidebar-footer">
        <span class="connection" data-state={state}>
          {state === "live" ? "Live" : state === "offline" ? "Reconnecting" : "Connecting"}
        </span>
        <span class="truncate" title={info?.path}>
          {info?.path ?? ""}
        </span>
      </div>
    </nav>
  );
}

export function TopBar(props: {
  title: ComponentChildren;
  actions?: ComponentChildren;
  onHelp: () => void;
}) {
  return (
    <header class="topbar">
      <div class="topbar-title">{props.title}</div>
      <div class="topbar-actions">
        <Search />
        {props.actions}
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={props.onHelp}
        >
          <Icon name="help" />
        </button>
        <button
          type="button"
          class="btn primary"
          onClick={() => {
            addJobOpen.value = true;
          }}
        >
          <Icon name="plus" size={14} /> Add job <kbd>N</kbd>
        </button>
      </div>
    </header>
  );
}
