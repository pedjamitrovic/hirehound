import type { AnchorHTMLAttributes, ComponentChildren } from "preact";
import type { ScoreBand } from "../../shared/schemas/evaluation.ts";
import type { JobState } from "../../shared/schemas/status.ts";
import { STATE_LABELS } from "../../shared/states.ts";
import { keyLabels } from "../hotkeys.ts";
import { onLinkClick } from "../router.ts";
import { Icon, type IconName } from "./Icon.tsx";

export function Link(props: AnchorHTMLAttributes & { href: string; children?: ComponentChildren }) {
  const { href, onClick, ...rest } = props;
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        if (typeof onClick === "function") onClick(event);
        onLinkClick(event, href);
      }}
    />
  );
}

export function Kbd(props: { keys: string }) {
  const steps = keyLabels(props.keys);
  return (
    <>
      {steps.map((parts, i) => (
        <span key={i} style={{ display: "inline-flex", gap: "2px" }}>
          {i > 0 ? <span class="muted"> then </span> : null}
          {parts.map((part) => (
            <kbd key={part}>{part}</kbd>
          ))}
        </span>
      ))}
    </>
  );
}

export function StateBadge(props: { state: JobState; external?: boolean }) {
  return (
    <span class="badge state-badge" data-state={props.state}>
      {STATE_LABELS[props.state]}
      {props.external ? " (external)" : null}
    </span>
  );
}

export function Score(props: { score: number | null; band: ScoreBand | null }) {
  return (
    <span
      class="score"
      data-band={props.band ?? undefined}
      title={props.score === null ? "Not evaluated yet" : `Fit score ${props.score}`}
    >
      {props.score ?? "--"}
    </span>
  );
}

export function EmptyState(props: {
  icon: IconName;
  title: string;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  compact?: boolean;
}) {
  return (
    <div class={`empty${props.compact ? " compact" : ""}`}>
      <div class="empty-icon">
        <Icon name={props.icon} size={18} />
      </div>
      <h2>{props.title}</h2>
      {props.children ? <p>{props.children}</p> : null}
      {props.actions ? <div class="actions">{props.actions}</div> : null}
    </div>
  );
}

export function Notice(props: {
  kind?: "info" | "warning" | "danger";
  children: ComponentChildren;
}) {
  const kind = props.kind ?? "info";
  return (
    <div class={`notice ${kind === "info" ? "" : kind}`} role={kind === "info" ? "note" : "alert"}>
      <Icon name={kind === "info" ? "info" : "alert"} size={14} />
      <div>{props.children}</div>
    </div>
  );
}

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.getFullYear() === new Date().getFullYear()
    ? DATE.format(date)
    : DATE_YEAR.format(date);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date);
}

/** "3h", "2d", "5w": compact age for dense lists. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 21) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}
