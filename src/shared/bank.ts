import { BANK_PREFIXES } from "./enums.ts";
import type { BankEntry, BankFile, BankKind, BankPrefix } from "./schemas/bank.ts";

export type IndexedEntry = {
  id: string;
  kind: BankKind;
  entry: BankEntry;
  /** Role or project id for achievements. */
  parent?: string;
};

const KIND_BY_PREFIX = new Map<string, BankKind>(
  Object.entries(BANK_PREFIXES).map(([kind, prefix]) => [prefix, kind as BankKind]),
);

export function kindOfId(id: string): BankKind | undefined {
  return KIND_BY_PREFIX.get(id.split("-")[0] ?? "");
}

/** Every entry by id, including achievements nested under roles and projects. */
export function indexBank(bank: BankFile): Map<string, IndexedEntry> {
  const index = new Map<string, IndexedEntry>();
  for (const role of bank.roles) {
    index.set(role.id, { id: role.id, kind: "role", entry: role });
    for (const a of role.achievements) {
      index.set(a.id, { id: a.id, kind: "achievement", entry: a, parent: role.id });
    }
  }
  for (const project of bank.projects) {
    index.set(project.id, { id: project.id, kind: "project", entry: project });
    for (const a of project.achievements) {
      index.set(a.id, { id: a.id, kind: "achievement", entry: a, parent: project.id });
    }
  }
  const flat: [BankKind, BankEntry[]][] = [
    ["education", bank.education],
    ["certification", bank.certifications],
    ["skill", bank.skills],
    ["language", bank.languages],
    ["award", bank.awards],
  ];
  for (const [kind, list] of flat) {
    for (const entry of list) index.set(entry.id, { id: entry.id, kind, entry });
  }
  return index;
}

function numberOf(id: string): number {
  const n = Number(id.split("-")[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Hands out new ids. The counter for a prefix is the larger of the stored counter and the highest
 * id present, so ids are never reused even if the file was edited by hand.
 */
export class IdAllocator {
  readonly #counters: Map<string, number>;

  constructor(bank: Pick<BankFile, "id_counters"> & Partial<BankFile>) {
    this.#counters = new Map(Object.entries(bank.id_counters ?? {}));
    if ("roles" in bank && bank.roles) {
      for (const id of indexBank(bank as BankFile).keys()) {
        const prefix = id.split("-")[0] ?? "";
        this.#counters.set(prefix, Math.max(this.#counters.get(prefix) ?? 0, numberOf(id)));
      }
    }
  }

  next(prefix: BankPrefix): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(3, "0")}`;
  }

  counters(): Record<string, number> {
    return Object.fromEntries([...this.#counters].sort(([a], [b]) => a.localeCompare(b)));
  }
}

export type BankStats = { total: number; confirmed: number; byKind: Record<BankKind, number> };

export function bankStats(bank: BankFile): BankStats {
  const byKind = Object.fromEntries(Object.keys(BANK_PREFIXES).map((k) => [k, 0])) as Record<
    BankKind,
    number
  >;
  let confirmed = 0;
  let total = 0;
  for (const { kind, entry } of indexBank(bank).values()) {
    byKind[kind] += 1;
    total += 1;
    if (entry.confirmed) confirmed += 1;
  }
  return { total, confirmed, byKind };
}

const period = (start?: string, end?: string) =>
  start || end ? ` (${start ?? "?"} - ${end ?? "?"})` : "";

/** Short human label for an entry, used in evidence chips and lists. */
export function entryLabel(indexed: IndexedEntry): string {
  const e = indexed.entry as Record<string, unknown>;
  switch (indexed.kind) {
    case "role":
      return `${e.title} at ${e.company}`;
    case "achievement":
      return String(e.text);
    case "project":
    case "certification":
    case "skill":
    case "language":
    case "award":
      return String(e.name);
    case "education":
      return [e.degree, e.field, e.institution].filter(Boolean).join(", ");
  }
}

/**
 * The bank as compact, line-oriented text for prompts. Each line starts with the entry id so the
 * model can cite it. With `confirmedOnly`, unreviewed entries are left out entirely.
 */
export function bankToPromptText(
  bank: BankFile,
  options: { confirmedOnly?: boolean } = {},
): string {
  const keep = (entry: { confirmed: boolean }) => !options.confirmedOnly || entry.confirmed;
  const lines: string[] = [];
  const push = (...parts: (string | undefined | false)[]) => {
    lines.push(parts.filter(Boolean).join(""));
  };
  const achievements = (list: BankFile["roles"][number]["achievements"], indent: string) => {
    for (const a of list.filter(keep)) {
      push(indent, a.id, ": ", a.text);
      if (a.metrics.length) push(indent, "  metrics: ", a.metrics.join("; "));
      if (a.skills.length) push(indent, "  skills: ", a.skills.join(", "));
      if (a.detail) push(indent, "  detail: ", a.detail.replace(/\s+/g, " ").trim());
    }
  };

  if (bank.roles.some(keep)) push("## Roles");
  for (const r of bank.roles.filter(keep)) {
    push(r.id, ": ", r.title, " at ", r.company, period(r.start, r.end));
    if (r.location) push("  location: ", r.location);
    if (r.employment_type) push("  type: ", r.employment_type);
    if (r.summary) push("  summary: ", r.summary.replace(/\s+/g, " ").trim());
    achievements(r.achievements, "  ");
  }
  if (bank.projects.some(keep)) push("## Projects");
  for (const p of bank.projects.filter(keep)) {
    push(p.id, ": ", p.name, p.role ? ` (${p.role})` : "", period(p.start, p.end));
    if (p.url) push("  url: ", p.url);
    if (p.summary) push("  summary: ", p.summary.replace(/\s+/g, " ").trim());
    achievements(p.achievements, "  ");
  }
  if (bank.education.some(keep)) push("## Education");
  for (const e of bank.education.filter(keep)) {
    push(
      e.id,
      ": ",
      [e.degree, e.field].filter(Boolean).join(", ") || "Studies",
      " at ",
      e.institution,
      period(e.start, e.end),
    );
    if (e.detail) push("  detail: ", e.detail.replace(/\s+/g, " ").trim());
  }
  if (bank.certifications.some(keep)) push("## Certifications");
  for (const c of bank.certifications.filter(keep)) {
    push(c.id, ": ", c.name, c.issuer ? `, ${c.issuer}` : "", c.date ? ` (${c.date})` : "");
  }
  if (bank.skills.some(keep)) push("## Skills");
  for (const s of bank.skills.filter(keep)) push(s.id, ": ", s.name, ": ", s.items.join(", "));
  if (bank.languages.some(keep)) push("## Languages");
  for (const l of bank.languages.filter(keep)) {
    push(l.id, ": ", l.name, l.level ? ` (${l.level})` : "");
  }
  if (bank.awards.some(keep)) push("## Awards");
  for (const a of bank.awards.filter(keep)) {
    push(a.id, ": ", a.name, a.issuer ? `, ${a.issuer}` : "", a.date ? ` (${a.date})` : "");
  }
  return lines.join("\n");
}
