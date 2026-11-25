import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ScanEntry, SourcesView, TaskInfo } from "../../shared/schemas/api.ts";
import { type Portal, PortalsFile } from "../../shared/schemas/portals.ts";
import type { Preferences } from "../../shared/schemas/preferences.ts";
import { isClosed } from "../../shared/states.ts";
import { localIsoDateTime } from "../../shared/time.ts";
import { formatPath } from "../../shared/validate.ts";
import { HttpError } from "../http/router.ts";
import { workplaceFrom } from "../jobs/extract.ts";
import type { JobService } from "../jobs/service.ts";
import { type Snapshot, textSha256 } from "../jobs/snapshot.ts";
import type { ProfileService } from "../profile/service.ts";
import type { TaskRunner } from "../tasks.ts";
import { readTextFile, writeFileAtomic } from "../workspace/fsx.ts";
import type { WorkspaceIndex } from "../workspace/index.ts";
import type { JobRecord } from "../workspace/job-files.ts";
import { sha256 } from "../workspace/job-files.ts";
import { updateYamlText } from "../workspace/yaml-edit.ts";
import { parseYaml } from "../workspace/yamlfile.ts";
import { BoardError, type DiscoveredPosting, fetchBoard } from "./ats.ts";
import { filterReason, roleKey } from "./filter.ts";
import { parseLinkedInAlert } from "./linkedin.ts";

export const PORTALS_FILE = "sources/portals.yaml";
export const SCANS_FILE = "sources/scans.jsonl";

const HEADER = `# Job boards Hirehound scans for you (Sources). Each portal is a company's public board on
# Greenhouse, Lever or Ashby: the board name is the part of its URL after the host.
`;

/** Postings Hirehound fetches at most per LinkedIn alert, to stay a polite visitor. */
const MAX_ALERT_FETCHES = 25;

type Deps = {
  root: string;
  index: WorkspaceIndex;
  jobs: JobService;
  profile: ProfileService;
  tasks: TaskRunner;
  fetchPosting: (url: string) => Promise<Snapshot>;
  fetchImpl?: typeof fetch;
};

type Progress = (message: string) => void;

const normalizeUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
};

/** What the workspace already knows, so a posting is never added twice. */
class Known {
  readonly #byRef = new Map<string, JobRecord>();
  readonly #byUrl = new Map<string, JobRecord>();
  readonly #byText = new Map<string, JobRecord>();
  readonly #byRole = new Map<string, JobRecord[]>();

  constructor(records: JobRecord[]) {
    for (const r of records) this.add(r);
  }

  add(r: JobRecord): void {
    const p = r.posting;
    if (!p) return;
    if (p.source_ref) this.#byRef.set(p.source_ref, r);
    if (p.url) this.#byUrl.set(normalizeUrl(p.url), r);
    if (r.postingBody.trim()) this.#byText.set(p.text_sha256, r);
    const key = roleKey(p.company, p.title);
    this.#byRole.set(key, [...(this.#byRole.get(key) ?? []), r]);
  }

  /** The same posting: same board id, same link or the same text. */
  same(p: DiscoveredPosting): JobRecord | undefined {
    return (
      this.#byRef.get(p.sourceRef) ??
      this.#byUrl.get(normalizeUrl(p.url)) ??
      (p.text.trim() ? this.#byText.get(textSha256(p.text)) : undefined)
    );
  }

  /** Jobs for the same company and role, newest first. */
  role(p: DiscoveredPosting): JobRecord[] {
    return [...(this.#byRole.get(roleKey(p.company, p.title)) ?? [])].sort((a, b) =>
      b.summary.addedAt.localeCompare(a.summary.addedAt),
    );
  }
}

/**
 * M5: discovery. Scans the public job boards in sources/portals.yaml, keeps what passes the
 * portal's and your filters, adds each new posting once as a Found job, notices postings that left
 * their board and records every scan in sources/scans.jsonl. It only ever creates Found jobs.
 */
export class DiscoveryService {
  readonly #d: Deps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #path(rel: string): string {
    return join(this.#d.root, ...rel.split("/"));
  }

  async readPortals() {
    const text = await readTextFile(this.#path(PORTALS_FILE));
    if (text === null) {
      return { text, value: PortalsFile.parse({}), sha256: null, diagnostics: [], valid: true };
    }
    const parsed = parseYaml(text, PortalsFile, { file: PORTALS_FILE });
    return {
      text,
      value: parsed.value ?? (parsed.empty ? PortalsFile.parse({}) : null),
      sha256: sha256(text),
      diagnostics: parsed.diagnostics,
      valid: parsed.value !== null || parsed.empty,
    };
  }

  async scans(limit = 50): Promise<ScanEntry[]> {
    const text = await readTextFile(this.#path(SCANS_FILE));
    const out: ScanEntry[] = [];
    for (const line of text?.split("\n").reverse() ?? []) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ScanEntry);
      } catch {
        // A torn line while a scan writes: skip it.
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** When the next scheduled scan is due, if scheduling is on. */
  async schedule(): Promise<{
    everyHours: number;
    lastAt: string | null;
    nextAt: string | null;
    portals: number;
  }> {
    const file = await this.readPortals();
    const everyHours = file.value?.schedule.every_hours ?? 0;
    const portals = file.value?.portals.filter((p) => p.enabled).length ?? 0;
    const last = (await this.scans(200)).find((s) => s.source !== "linkedin-email");
    const lastAt = last?.at ?? null;
    const nextAt =
      everyHours > 0 && portals > 0
        ? lastAt
          ? new Date(Date.parse(lastAt) + everyHours * 3_600_000).toISOString()
          : new Date().toISOString()
        : null;
    return { everyHours, lastAt, nextAt, portals };
  }

  async view(): Promise<SourcesView> {
    const file = await this.readPortals();
    const scans = await this.scans();
    const schedule = await this.schedule();
    return {
      file: { sha256: file.sha256, diagnostics: file.diagnostics },
      everyHours: schedule.everyHours,
      portals: (file.value?.portals ?? []).map((p) => ({
        ...p,
        lastScan: scans.find((s) => s.source === p.id) ?? null,
      })),
      lastScanAt: schedule.lastAt,
      nextScanAt: schedule.nextAt,
      scans,
    };
  }

  /** Saves portals and schedule, keeping comments; refuses to overwrite a newer file. */
  savePortals(value: unknown, expectedSha256: string | null): Promise<SourcesView> {
    const run = this.#queue.then(async () => {
      const parsed = PortalsFile.safeParse(value);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => ({
          path: formatPath(i.path),
          message: i.message,
        }));
        throw new HttpError(
          400,
          "invalid-request",
          issues[0] ? `${issues[0].path}: ${issues[0].message}` : "Invalid",
          issues,
        );
      }
      const current = await this.readPortals();
      if (current.sha256 !== expectedSha256) {
        throw new HttpError(
          409,
          "changed-on-disk",
          "sources/portals.yaml changed since you opened it (in another tab or an editor). Reload to see the latest version.",
        );
      }
      await writeFileAtomic(
        this.#path(PORTALS_FILE),
        updateYamlText(current.text, parsed.data, HEADER),
      );
      return this.view();
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #log(entry: ScanEntry): Promise<void> {
    await mkdir(this.#path("sources"), { recursive: true });
    await appendFile(this.#path(SCANS_FILE), `${JSON.stringify(entry)}\n`);
  }

  // ---------- Scanning ----------

  startScan(trigger: ScanEntry["trigger"], portalIds?: string[]): TaskInfo {
    return this.#d.tasks.start(
      "scan",
      portalIds?.length === 1 ? "Scanning a job board" : "Scanning your job boards",
      async (ctx) => {
        const entries = await this.scan(trigger, portalIds, ctx.progress);
        return summarize(entries);
      },
      { exclusive: true },
    );
  }

  /** Scans the enabled portals (or the given ones) one after another. */
  async scan(
    trigger: ScanEntry["trigger"],
    portalIds?: string[],
    progress: Progress = () => {},
  ): Promise<ScanEntry[]> {
    const file = await this.readPortals();
    if (!file.value) {
      throw new HttpError(
        409,
        "portals-invalid",
        "sources/portals.yaml has errors. Fix it first (Sources).",
      );
    }
    const portals = file.value.portals.filter((p) =>
      portalIds ? portalIds.includes(p.id) : p.enabled,
    );
    if (portals.length === 0)
      throw new HttpError(409, "no-portals", "Add a job board to scan first (Sources).");
    const prefs = (await this.#d.profile.preferences()).value;
    const entries: ScanEntry[] = [];
    for (const [i, portal] of portals.entries()) {
      progress(`Scanning ${portal.company} (${i + 1} of ${portals.length})`);
      const entry = await this.#scanPortal(portal, prefs, trigger);
      await this.#log(entry);
      entries.push(entry);
    }
    return entries;
  }

  async #scanPortal(
    portal: Portal,
    prefs: Preferences | null,
    trigger: ScanEntry["trigger"],
  ): Promise<ScanEntry> {
    const entry: ScanEntry = {
      at: localIsoDateTime(),
      source: portal.id,
      trigger,
      ok: true,
      listed: 0,
      added: [],
      duplicates: 0,
      filtered: [],
      gone: [],
      back: [],
    };
    let postings: DiscoveredPosting[];
    try {
      postings = await fetchBoard(
        portal,
        this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {},
      );
    } catch (error) {
      // A board that cannot be read says nothing about which jobs are gone: change nothing.
      return {
        ...entry,
        ok: false,
        error: error instanceof BoardError ? error.message : String(error),
      };
    }
    entry.listed = postings.length;
    const known = new Known(this.#records());
    const seen = new Set<string>();
    for (const p of postings) {
      seen.add(p.sourceRef);
      const outcome = await this.#consider(p, known, portal, prefs);
      if (outcome.kind === "added") entry.added.push(outcome.added);
      else if (outcome.kind === "filtered") entry.filtered.push(outcome.filtered);
      else {
        entry.duplicates += 1;
        if (outcome.back) entry.back.push(outcome.back);
      }
    }

    // Liveness: jobs from this board that it no longer lists. A board that suddenly lists nothing
    // is more likely broken or moved than empty, so it changes nothing.
    const prefix = `${portal.provider}:${portal.board}:`;
    if (postings.length > 0) {
      for (const record of this.#records()) {
        const ref = record.posting?.source_ref;
        if (!ref?.startsWith(prefix) || seen.has(ref) || record.status?.listing?.live === false)
          continue;
        if (record.status && isClosed(record.status.state) && record.status.state !== "expired")
          continue;
        const { expired } = await this.#d.jobs.setListing(
          record.id,
          false,
          `No longer listed on the ${portal.company} job board`,
        );
        entry.gone.push({ id: record.id, title: record.summary.title, expired });
      }
    }
    return entry;
  }

  #records(): JobRecord[] {
    return this.#d.index
      .list()
      .map((s) => this.#d.index.get(s.id))
      .filter((r): r is JobRecord => r !== undefined);
  }

  /** Decides one posting: duplicate (maybe back on its board), filtered, or added. */
  async #consider(
    p: DiscoveredPosting,
    known: Known,
    portal: Portal | null,
    prefs: Preferences | null,
    fill?: (p: DiscoveredPosting) => Promise<{ text?: string; html?: string }>,
  ): Promise<
    | { kind: "added"; added: ScanEntry["added"][number] }
    | { kind: "filtered"; filtered: ScanEntry["filtered"][number] }
    | { kind: "duplicate"; back?: { id: string; title: string } }
  > {
    const same = known.same(p);
    if (same) {
      if (same.status?.listing?.live === false) {
        await this.#d.jobs.setListing(same.id, true, "Listed again");
        return { kind: "duplicate", back: { id: same.id, title: same.summary.title } };
      }
      return { kind: "duplicate" };
    }
    const reason = filterReason(p, portal, prefs);
    if (reason) {
      return {
        kind: "filtered",
        filtered: { ref: p.sourceRef, title: p.title, url: p.url, location: p.location, reason },
      };
    }
    // Same company and role: an open job means the same opening seen elsewhere; a closed one
    // means the role was posted again.
    const role = known.role(p);
    if (role.some((r) => r.status && !isClosed(r.status.state))) return { kind: "duplicate" };
    const repostOf = role[0]?.id;
    const extra = fill ? await fill(p) : {};
    const record = await this.#d.jobs.createDiscovered(p, { repostOf, ...extra });
    known.add(record);
    return {
      kind: "added",
      added: { id: record.id, title: p.title, ...(repostOf ? { repostOf } : {}) },
    };
  }

  /** Adds a posting a scan filtered out, after all. */
  async addFiltered(source: string, ref: string): Promise<JobRecord> {
    const file = await this.readPortals();
    const portal = file.value?.portals.find((p) => p.id === source);
    if (!portal) throw new HttpError(404, "no-portal", `There is no portal "${source}" any more.`);
    let postings: DiscoveredPosting[];
    try {
      postings = await fetchBoard(
        portal,
        this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {},
      );
    } catch (error) {
      throw new HttpError(502, "board-failed", (error as Error).message);
    }
    const posting = postings.find((p) => p.sourceRef === ref);
    if (!posting) throw new HttpError(410, "gone", "That posting is no longer on the board.");
    const same = new Known(this.#records()).same(posting);
    if (same)
      throw new HttpError(409, "exists", `It is already in your pipeline (${same.summary.title}).`);
    return this.#d.jobs.createDiscovered(posting);
  }

  // ---------- LinkedIn alerts ----------

  startAlertImport(text: string): TaskInfo {
    const cards = parseLinkedInAlert(text);
    if (cards.length === 0) {
      throw new HttpError(
        400,
        "no-jobs",
        "No LinkedIn job links found. Upload the alert email (.eml) or paste its full text.",
      );
    }
    return this.#d.tasks.start(
      "import-alert",
      `Importing ${cards.length} ${cards.length === 1 ? "job" : "jobs"} from a LinkedIn alert`,
      async (ctx) => summarize([await this.importAlert(text, ctx.progress)]),
      { exclusive: true },
    );
  }

  /**
   * Adds the jobs in a LinkedIn job-alert email. Each public job page is fetched once with an
   * ordinary request; when LinkedIn refuses (it often does for signed-out visitors), the job keeps
   * the alert's details and asks you for the posting text. Never signs in, never works around it.
   */
  async importAlert(text: string, progress: Progress = () => {}): Promise<ScanEntry> {
    const cards = parseLinkedInAlert(text);
    const prefs = (await this.#d.profile.preferences()).value;
    const entry: ScanEntry = {
      at: localIsoDateTime(),
      source: "linkedin-email",
      trigger: "import",
      ok: true,
      listed: cards.length,
      added: [],
      duplicates: 0,
      filtered: [],
      gone: [],
      back: [],
    };
    const known = new Known(this.#records());
    let fetches = 0;
    const fill = async (p: DiscoveredPosting) => {
      if (fetches >= MAX_ALERT_FETCHES) return {};
      fetches += 1;
      try {
        const snapshot = await this.#d.fetchPosting(p.url);
        return snapshot.text.length >= 200 ? { text: snapshot.text, html: snapshot.html } : {};
      } catch {
        return {};
      }
    };
    for (const [i, card] of cards.entries()) {
      progress(`Adding ${card.title} (${i + 1} of ${cards.length})`);
      const posting: DiscoveredPosting = {
        provider: "linkedin-email",
        sourceRef: `linkedin:${card.id}`,
        company: card.company ?? "",
        title: card.title,
        url: card.url,
        location: card.location,
        workplace: workplaceFrom(null, card.location),
        employmentType: "unknown",
        salary: null,
        postedAt: null,
        text: "",
      };
      if (!card.company) {
        entry.filtered.push({
          ref: posting.sourceRef,
          title: card.title,
          url: card.url,
          location: card.location,
          reason: "The alert does not say which company it is",
        });
        continue;
      }
      const outcome = await this.#consider(posting, known, null, prefs, fill);
      if (outcome.kind === "added") entry.added.push(outcome.added);
      else if (outcome.kind === "filtered") entry.filtered.push(outcome.filtered);
      else entry.duplicates += 1;
    }
    await this.#log(entry);
    return entry;
  }
}

/** The task result: what a scan or import did, in numbers. */
export function summarize(entries: ScanEntry[]) {
  return {
    sources: entries.length,
    failed: entries.filter((e) => !e.ok).map((e) => ({ source: e.source, error: e.error })),
    added: entries.reduce((n, e) => n + e.added.length, 0),
    filtered: entries.reduce((n, e) => n + e.filtered.length, 0),
    duplicates: entries.reduce((n, e) => n + e.duplicates, 0),
    gone: entries.reduce((n, e) => n + e.gone.length, 0),
    expired: entries.reduce((n, e) => n + e.gone.filter((g) => g.expired).length, 0),
  };
}
