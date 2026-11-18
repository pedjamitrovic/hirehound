import { computed, signal } from "@preact/signals";

export type TabId =
  | "posting"
  | "evaluation"
  | "cv"
  | "cover-letter"
  | "application"
  | "interview"
  | "timeline";

export const JOB_TABS: readonly TabId[] = [
  "posting",
  "evaluation",
  "cv",
  "cover-letter",
  "application",
  "interview",
  "timeline",
];

export type Route =
  | { name: "today" }
  | { name: "pipeline" }
  | { name: "job"; id: string; tab: TabId }
  | { name: "profile" }
  | { name: "sources" }
  | { name: "insights" }
  | { name: "settings" }
  | { name: "not-found"; path: string };

type Location = { pathname: string; search: string };

const current = (): Location => ({
  pathname: window.location.pathname,
  search: window.location.search,
});

export const location = signal<Location>(current());

window.addEventListener("popstate", () => {
  location.value = current();
});

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [first, second, third] = parts;
  if (parts.length === 0) return { name: "today" };
  if (first === "jobs" && second && parts.length <= 3) {
    const tab = JOB_TABS.find((t) => t === third) ?? "posting";
    if (third && !JOB_TABS.includes(third as TabId)) return { name: "not-found", path: pathname };
    return { name: "job", id: second, tab };
  }
  if (parts.length === 1) {
    switch (first) {
      case "pipeline":
      case "profile":
      case "sources":
      case "insights":
      case "settings":
        return { name: first };
    }
  }
  return { name: "not-found", path: pathname };
}

export const route = computed(() => parseRoute(location.value.pathname));

export const searchParams = computed(() => new URLSearchParams(location.value.search));

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  const next = url.pathname + url.search;
  if (next === window.location.pathname + window.location.search) return;
  if (options.replace) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
  location.value = current();
}

/** Updates query parameters in place (filters, view mode) without adding history entries. */
export function setSearchParams(update: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  navigate(`${window.location.pathname}${query ? `?${query}` : ""}`, { replace: true });
}

export function jobPath(id: string, tab?: TabId): string {
  const base = `/jobs/${encodeURIComponent(id)}`;
  return tab && tab !== "posting" ? `${base}/${tab}` : base;
}

/** Click handler for in-app links: plain left clicks navigate, modified clicks behave natively. */
export function onLinkClick(event: MouseEvent, href: string): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  navigate(href);
}
