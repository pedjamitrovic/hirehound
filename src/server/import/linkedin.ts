// LinkedIn "Get a copy of your data" exports: a ZIP of CSV files. Only the career-related files
// are read; messages, connections, contacts, ads and login data never are. Values are kept as
// written (dates included) so the AI drafting the experience bank does not have to guess.
import { parseCsv } from "./csv.ts";
import type { ZipEntry } from "./zip.ts";
import { listZip, readZipText } from "./zip.ts";

type FileSpec = {
  /** Lowercase file name; matched case-insensitively in any folder. */
  file: string;
  /** The header is the first row with one of these columns; "Notes:" preamble rows come first. */
  keys: readonly string[];
};

const FILES = {
  profile: { file: "profile.csv", keys: ["First Name"] },
  positions: { file: "positions.csv", keys: ["Company Name"] },
  education: { file: "education.csv", keys: ["School Name"] },
  skills: { file: "skills.csv", keys: ["Name"] },
  certifications: { file: "certifications.csv", keys: ["Name"] },
  languages: { file: "languages.csv", keys: ["Name"] },
  projects: { file: "projects.csv", keys: ["Title"] },
  honors: { file: "honors.csv", keys: ["Title"] },
  publications: { file: "publications.csv", keys: ["Name", "Title"] },
  volunteering: { file: "volunteering.csv", keys: ["Organization", "Company Name", "Role"] },
  recommendations: { file: "recommendations_received.csv", keys: ["Text"] },
} as const satisfies Record<string, FileSpec>;

type CsvRecord = Map<string, string>;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

/** True when the archive looks like a LinkedIn data export. */
export function isLinkedInExport(entries: ZipEntry[]): boolean {
  return entries.some(
    (entry) =>
      !entry.isDirectory &&
      (baseName(entry.name) === FILES.positions.file ||
        baseName(entry.name) === FILES.profile.file),
  );
}

/** A Markdown document with the career sections of the export, or "" when there are none. */
export function linkedInToText(data: Uint8Array): string {
  const entries = listZip(data);
  const read = (spec: FileSpec) => readRecords(data, entries, spec);

  const sections = [
    section("Profile", renderProfile(read(FILES.profile))),
    section("Positions", entryList(read(FILES.positions), renderPosition)),
    section("Education", entryList(read(FILES.education), renderEducation)),
    section("Skills", bulletList(read(FILES.skills), renderSkill)),
    section("Certifications", entryList(read(FILES.certifications), renderCertification)),
    section("Languages", bulletList(read(FILES.languages), renderLanguage)),
    section("Projects", entryList(read(FILES.projects), renderProject)),
    section("Honors and awards", entryList(read(FILES.honors), renderHonor)),
    section("Publications", entryList(read(FILES.publications), renderPublication)),
    section("Volunteering", entryList(read(FILES.volunteering), renderVolunteering)),
    section(
      "Recommendations received",
      entryList(read(FILES.recommendations), renderRecommendation),
    ),
  ].filter((text) => text !== "");

  return sections.length > 0 ? ["# LinkedIn export", ...sections].join("\n\n") : "";
}

function readRecords(data: Uint8Array, entries: ZipEntry[], spec: FileSpec): CsvRecord[] {
  const entry = entries.find((e) => !e.isDirectory && baseName(e.name) === spec.file);
  if (!entry) return [];
  const rows = parseCsv(readZipText(data, entry.name));
  const keys = spec.keys.map((key) => key.toLowerCase());
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => keys.includes(cell.trim().toLowerCase())),
  );
  const header = rows[headerIndex]?.map((cell) => cell.trim().toLowerCase());
  if (!header) return [];

  const records: CsvRecord[] = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (row.every((cell) => cell.trim() === "")) continue;
    const record: CsvRecord = new Map();
    for (const [i, column] of header.entries()) {
      if (column !== "" && !record.has(column)) record.set(column, row[i] ?? "");
    }
    records.push(record);
  }
  return records;
}

// Email addresses can turn up in free text (a summary, a recommendation). They are contact
// details, not experience, so they never reach the AI.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function raw(record: CsvRecord, columns: string[]): string {
  for (const column of columns) {
    const value = record.get(column.toLowerCase())?.trim();
    if (value) return value.replace(EMAIL, "[email removed]");
  }
  return "";
}

/** A single-line value: the first non-empty one of the given columns. */
function get(record: CsvRecord, ...columns: string[]): string {
  return raw(record, columns).replace(/\s+/g, " ");
}

/** A multi-line value with trimmed lines and at most one blank line in a row. */
function getBlock(record: CsvRecord, ...columns: string[]): string {
  return raw(record, columns)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function labeled(label: string, value: string): string {
  if (!value) return "";
  return value.includes("\n") ? `${label}:\n${value}` : `${label}: ${value}`;
}

function at(title: string, organization: string): string {
  if (title && organization) return `${title} at ${organization}`;
  return title || organization;
}

function range(start: string, end: string, openEnd: string): string {
  if (!start && !end) return "";
  return `${start || "?"} - ${end || openEnd}`;
}

function entry(heading: string, ...lines: string[]): string {
  return [`### ${heading}`, ...lines.filter((line) => line !== "")].join("\n");
}

function section(title: string, body: string): string {
  return body ? `## ${title}\n${body}` : "";
}

function entryList(records: CsvRecord[], render: (record: CsvRecord) => string): string {
  return records
    .map(render)
    .filter((text) => text !== "")
    .join("\n\n");
}

function bulletList(records: CsvRecord[], render: (record: CsvRecord) => string): string {
  return records
    .map(render)
    .filter((text) => text !== "")
    .map((text) => `- ${text}`)
    .join("\n");
}

// Profile.csv also has Birth Date, Address, Zip Code, Instant Messengers and more. Only the
// columns below are ever read.
function renderProfile(records: CsvRecord[]): string {
  const profile = records[0];
  if (!profile) return "";
  const name = [get(profile, "First Name"), get(profile, "Last Name")].filter(Boolean).join(" ");
  const summary = getBlock(profile, "Summary");
  return [
    labeled("Name", name),
    labeled("Headline", get(profile, "Headline")),
    labeled("Industry", get(profile, "Industry")),
    labeled("Location", get(profile, "Geo Location")),
    labeled("Websites", get(profile, "Websites")),
    summary ? `Summary:\n${summary}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderPosition(r: CsvRecord): string {
  return entry(
    at(get(r, "Title"), get(r, "Company Name")) || "Position",
    labeled("Dates", range(get(r, "Started On"), get(r, "Finished On"), "present")),
    labeled("Location", get(r, "Location")),
    getBlock(r, "Description"),
  );
}

function renderEducation(r: CsvRecord): string {
  return entry(
    get(r, "School Name") || "School",
    labeled("Degree", get(r, "Degree Name")),
    labeled("Dates", range(get(r, "Start Date"), get(r, "End Date"), "?")),
    labeled("Notes", getBlock(r, "Notes")),
    labeled("Activities", getBlock(r, "Activities")),
  );
}

function renderCertification(r: CsvRecord): string {
  return entry(
    get(r, "Name") || "Certification",
    labeled("Authority", get(r, "Authority")),
    labeled("Issued", get(r, "Started On")),
    labeled("Expires", get(r, "Finished On")),
    labeled("License number", get(r, "License Number")),
    labeled("URL", get(r, "Url")),
  );
}

function renderSkill(r: CsvRecord): string {
  return get(r, "Name");
}

function renderLanguage(r: CsvRecord): string {
  const name = get(r, "Name");
  const proficiency = get(r, "Proficiency");
  return name && proficiency ? `${name} (${proficiency})` : name;
}

function renderProject(r: CsvRecord): string {
  return entry(
    get(r, "Title") || "Project",
    labeled("Dates", range(get(r, "Started On"), get(r, "Finished On"), "present")),
    labeled("URL", get(r, "Url")),
    getBlock(r, "Description"),
  );
}

function renderHonor(r: CsvRecord): string {
  return entry(
    get(r, "Title") || "Honor",
    labeled("Issued", get(r, "Issued On")),
    getBlock(r, "Description"),
  );
}

function renderPublication(r: CsvRecord): string {
  return entry(
    get(r, "Name", "Title") || "Publication",
    labeled("Publisher", get(r, "Publisher")),
    labeled("Published", get(r, "Published On")),
    labeled("URL", get(r, "Url")),
    getBlock(r, "Description"),
  );
}

function renderVolunteering(r: CsvRecord): string {
  return entry(
    at(get(r, "Role"), get(r, "Company Name", "Organization")) || "Volunteering",
    labeled("Cause", get(r, "Cause")),
    labeled("Dates", range(get(r, "Started On"), get(r, "Finished On"), "present")),
    getBlock(r, "Description"),
  );
}

/** Only visible recommendations; pending or hidden ones are not part of the public profile. */
function renderRecommendation(r: CsvRecord): string {
  const status = get(r, "Status");
  const text = getBlock(r, "Text");
  if ((status && status.toUpperCase() !== "VISIBLE") || !text) return "";
  const name = [get(r, "First Name"), get(r, "Last Name")].filter(Boolean).join(" ");
  return entry(
    name ? `From ${name}` : "Recommendation",
    labeled("Role", at(get(r, "Job Title"), get(r, "Company"))),
    labeled("Date", get(r, "Creation Date")),
    text,
  );
}
