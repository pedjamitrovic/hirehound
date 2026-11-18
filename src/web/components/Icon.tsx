import type { JSX } from "preact";

const PATHS = {
  today: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  pipeline: (
    <>
      <rect x="1.75" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="6.25" y="2.5" width="3.5" height="7.5" rx="1" />
      <rect x="10.75" y="2.5" width="3.5" height="9" rx="1" />
    </>
  ),
  profile: (
    <>
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14c.6-2.6 2.7-4.25 5.25-4.25S12.65 11.4 13.25 14" />
    </>
  ),
  sources: (
    <>
      <circle cx="8" cy="8" r="1.25" />
      <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 12.9a7 7 0 0 1 0-9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
    </>
  ),
  insights: <path d="M2 13.5h12M4 11V7.5M7 11V4M10 11V8.5M13 11V5.5" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.05 1.05M4.65 11.35 3.6 12.4M12.4 12.4l-1.05-1.05M4.65 4.65 3.6 3.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.5 3.5" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  help: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.5M8 11.6v.1" />
    </>
  ),
  external: (
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
  ),
  folder: (
    <path d="M1.75 4.5a1 1 0 0 1 1-1h3.4l1.4 1.5h5.7a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="m3 8.5 3.25 3.25L13 5" />,
  alert: (
    <>
      <path d="M8 2.25 14.25 13.5H1.75z" />
      <path d="M8 6.5v3M8 11.5v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.1" />
    </>
  ),
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  chevronDown: <path d="m3.5 6 4.5 4.5L12.5 6" />,
  arrowLeft: <path d="M13 8H3M7 4 3 8l4 4" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="0.6" />
      <circle cx="8" cy="8" r="0.6" />
      <circle cx="12.5" cy="8" r="0.6" />
    </>
  ),
  link: (
    <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9 0l2.1-2.1a2.75 2.75 0 0 0-3.9-3.9l-.6.6M9.25 6.75a2.75 2.75 0 0 0-3.9 0l-2.1 2.1a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
  ),
  text: <path d="M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6" />,
  note: <path d="M3.5 2.5h6l3 3v8h-9zM9.5 2.5v3h3M5.5 8.5h5M5.5 11h3.5" />,
  user: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3.5 13.5c.5-2.2 2.3-3.5 4.5-3.5s4 1.3 4.5 3.5" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" />,
  board: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M6 2.5v11M10 2.5v11" />
    </>
  ),
  table: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M2 9.5h12M6 6v7.5" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof PATHS;

/** 16px line icon. Decorative unless `title` is given, in which case it is announced. */
export function Icon(props: { name: IconName; size?: number; class?: string; title?: string }) {
  const common = {
    class: props.class,
    width: props.size ?? 16,
    height: props.size ?? 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  } as const;
  if (props.title) {
    return (
      <svg {...common} role="img" aria-label={props.title}>
        <title>{props.title}</title>
        {PATHS[props.name]}
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      {PATHS[props.name]}
    </svg>
  );
}
