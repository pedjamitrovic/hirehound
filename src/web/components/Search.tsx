import { useMemo, useRef, useState } from "preact/hooks";
import { useHotkeys } from "../hotkeys.ts";
import { jobPath, navigate } from "../router.ts";
import { jobList } from "../state/store.ts";
import { Icon } from "./Icon.tsx";
import { StateBadge } from "./ui.tsx";

function matches(query: string, ...fields: (string | null)[]): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Quick job search in the top bar: "/" to focus, arrows to pick, Enter to open. */
export function Search() {
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);

  useHotkeys([
    {
      keys: "/",
      group: "General",
      description: "Search jobs",
      run: () => input.current?.focus(),
    },
  ]);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return jobList.value
      .filter((j) => matches(query, j.company, j.title, j.location, j.id))
      .slice(0, 8);
  }, [query, jobList.value]);

  const openJob = (id: string) => {
    setQuery("");
    setOpen(false);
    input.current?.blur();
    navigate(jobPath(id));
  };

  return (
    <div class="search">
      <Icon name="search" size={14} class="search-icon" />
      <input
        ref={input}
        class="input"
        type="search"
        placeholder="Search jobs"
        aria-label="Search jobs"
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((s) => Math.min(s + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((s) => Math.max(s - 1, 0));
          } else if (e.key === "Enter") {
            const hit = results[selected];
            if (hit) openJob(hit.id);
          } else if (e.key === "Escape") {
            setQuery("");
            e.currentTarget.blur();
          }
        }}
      />
      {!query ? <kbd>/</kbd> : null}
      {open && query.trim() ? (
        <div class="search-results" role="listbox">
          {results.length === 0 ? (
            <div class="muted" style={{ padding: "6px 8px" }}>
              No jobs match "{query}"
            </div>
          ) : (
            results.map((job, i) => (
              <button
                type="button"
                key={job.id}
                role="option"
                aria-selected={i === selected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openJob(job.id)}
              >
                <strong class="truncate">{job.company}</strong>
                <span class="truncate secondary">{job.title}</span>
                <span style={{ marginLeft: "auto" }}>
                  <StateBadge state={job.state} />
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
