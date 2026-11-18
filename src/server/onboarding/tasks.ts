import { z } from "zod";
import { bankToPromptText, indexBank } from "../../shared/bank.ts";
import { checkEvidence } from "../../shared/cv/evidence.ts";
import { parseCv } from "../../shared/cv/parse.ts";
import type { BankFile, BankKind } from "../../shared/schemas/bank.ts";
import type { TaskDef } from "../ai/run-task.ts";
import type { Attachment } from "../ai/types.ts";
import type { BankOp, DraftEntry } from "../profile/bank-ops.ts";

// AI output contracts use `nullable` for "not stated" (structured outputs prefer every field
// present). Dates must be YYYY or YYYY-MM exactly as the source supports; never guessed.

const DraftDate = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/, "dates are YYYY or YYYY-MM")
  .nullable();
const DraftEnd = z.union([z.literal("present"), DraftDate]);
const Text = z.string().min(1);

const DraftAchievement = z.object({
  ref: Text,
  text: Text,
  detail: z.string().nullable(),
  metrics: z.array(z.string()),
  skills: z.array(z.string()),
  source: Text,
});

const DraftRole = z.object({
  ref: Text,
  company: Text,
  title: Text,
  start: DraftDate,
  end: DraftEnd,
  location: z.string().nullable(),
  employment_type: z
    .enum(["full-time", "part-time", "contract", "freelance", "internship"])
    .nullable(),
  summary: z.string().nullable(),
  source: Text,
  achievements: z.array(DraftAchievement),
});

const DraftProject = z.object({
  ref: Text,
  name: Text,
  role: z.string().nullable(),
  start: DraftDate,
  end: DraftEnd,
  url: z.string().nullable(),
  summary: z.string().nullable(),
  source: Text,
  achievements: z.array(DraftAchievement),
});

export const DraftBankOutput = z.object({
  contact: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    links: z.array(z.object({ label: Text, url: Text })),
  }),
  roles: z.array(DraftRole),
  projects: z.array(DraftProject),
  education: z.array(
    z.object({
      ref: Text,
      institution: Text,
      degree: z.string().nullable(),
      field: z.string().nullable(),
      start: DraftDate,
      end: DraftEnd,
      location: z.string().nullable(),
      detail: z.string().nullable(),
      source: Text,
    }),
  ),
  certifications: z.array(
    z.object({
      ref: Text,
      name: Text,
      issuer: z.string().nullable(),
      date: DraftDate,
      url: z.string().nullable(),
      source: Text,
    }),
  ),
  skills: z.array(z.object({ ref: Text, name: Text, items: z.array(Text).min(1), source: Text })),
  languages: z.array(
    z.object({ ref: Text, name: Text, level: z.string().nullable(), source: Text }),
  ),
  awards: z.array(
    z.object({
      ref: Text,
      name: Text,
      issuer: z.string().nullable(),
      date: DraftDate,
      detail: z.string().nullable(),
      source: Text,
    }),
  ),
  questions: z.array(
    z.object({
      /** The ref of the entry it is about, or null for a general question. */
      about: z.string().nullable(),
      question: Text,
      why: Text,
    }),
  ),
});
export type DraftBankOutput = z.infer<typeof DraftBankOutput>;

export type SourceDoc = { name: string; attachment: Attachment };

export type DraftBankInput = {
  sources: SourceDoc[];
  /** The current bank, so the draft adds only what is new. */
  existing: BankFile | null;
};

/** Removes nulls (not stated) so entries only carry what the source says. */
function stated<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
}

export const draftBankTask: TaskDef<DraftBankInput, DraftBankOutput> = {
  name: "draft-bank",
  schema: DraftBankOutput,
  effort: "high",
  maxOutputTokens: 64_000,
  render: (input) => ({
    attachments: input.sources.map((s) => s.attachment),
    input: [
      `Source files (use these exact names in "source"): ${input.sources.map((s) => s.name).join(", ")}`,
      input.existing
        ? `\nThe experience bank already contains the entries below. Do not repeat them; only add facts that are new.\n\n${bankToPromptText(input.existing)}`
        : "\nThe experience bank is empty.",
      "\nDraft the experience bank from the source files now.",
    ].join("\n"),
  }),
  postCheck: (output, input) => {
    const problems: string[] = [];
    const names = new Set(input.sources.map((s) => s.name));
    const refs = new Set<string>();
    const visit = (ref: string, source: string, where: string) => {
      if (refs.has(ref)) problems.push(`${where}: ref "${ref}" is used twice; refs must be unique`);
      refs.add(ref);
      if (!names.has(source))
        problems.push(`${where}: source "${source}" is not one of the file names given`);
    };
    for (const role of output.roles) {
      visit(role.ref, role.source, `role ${role.title} at ${role.company}`);
      for (const a of role.achievements)
        visit(a.ref, a.source, `achievement "${a.text.slice(0, 40)}"`);
    }
    for (const p of output.projects) {
      visit(p.ref, p.source, `project ${p.name}`);
      for (const a of p.achievements)
        visit(a.ref, a.source, `achievement "${a.text.slice(0, 40)}"`);
    }
    for (const list of [
      output.education,
      output.certifications,
      output.skills,
      output.languages,
      output.awards,
    ]) {
      for (const entry of list) visit(entry.ref, entry.source, `entry ${entry.ref}`);
    }
    for (const q of output.questions) {
      if (q.about !== null && !refs.has(q.about)) {
        problems.push(`question "${q.question.slice(0, 40)}" refers to unknown ref "${q.about}"`);
      }
    }
    return problems;
  },
};

/** Converts a draft into bank entries; `source` becomes the stored import path. */
export function draftToEntries(
  output: DraftBankOutput,
  sourcePath: (name: string) => string,
): DraftEntry[] {
  const achievements = (list: z.infer<typeof DraftAchievement>[]) =>
    list.map(({ ref, source, ...rest }) => ({
      ref,
      entry: stated({ ...rest, source: sourcePath(source) }),
    }));
  const entries: DraftEntry[] = [];
  for (const { ref, source, achievements: a, ...rest } of output.roles) {
    entries.push({
      kind: "role",
      ref,
      entry: stated({ ...rest, source: sourcePath(source) }),
      achievements: achievements(a),
    });
  }
  for (const { ref, source, achievements: a, ...rest } of output.projects) {
    entries.push({
      kind: "project",
      ref,
      entry: stated({ ...rest, source: sourcePath(source) }),
      achievements: achievements(a),
    });
  }
  const flat: [Exclude<BankKind, "achievement">, { ref: string; source: string }[]][] = [
    ["education", output.education],
    ["certification", output.certifications],
    ["skill", output.skills],
    ["language", output.languages],
    ["award", output.awards],
  ];
  for (const [kind, list] of flat) {
    for (const { ref, source, ...rest } of list) {
      entries.push({ kind, ref, entry: stated({ ...rest, source: sourcePath(source) }) });
    }
  }
  return entries;
}

// ---------- Answers to gap questions -> proposed bank edits ----------

const FieldValue = z.union([z.string(), z.array(z.string()), z.null()]);

export const ApplyAnswersOutput = z.object({
  changes: z.array(
    z.object({
      id: Text,
      field: Text,
      /** null removes the field. */
      value: FieldValue,
      question: Text,
    }),
  ),
  additions: z.array(
    z.object({
      kind: z.enum([
        "achievement",
        "role",
        "project",
        "education",
        "certification",
        "skill",
        "language",
        "award",
      ]),
      /** Role or project id for a new achievement, otherwise null. */
      parent: z.string().nullable(),
      fields: z.array(z.object({ field: Text, value: z.union([z.string(), z.array(z.string())]) })),
      question: Text,
    }),
  ),
  /** Questions whose answer did not contain usable facts. */
  unused: z.array(z.object({ question: Text, reason: Text })),
});
export type ApplyAnswersOutput = z.infer<typeof ApplyAnswersOutput>;

export type AnsweredQuestion = {
  id: string;
  entry?: string | undefined;
  question: string;
  answer: string;
};

export type ApplyAnswersInput = { bank: BankFile; answered: AnsweredQuestion[] };

/** Fields the AI may change, per entry kind. Anything else is rejected. */
export const EDITABLE_FIELDS: Record<BankKind, string[]> = {
  role: ["company", "title", "start", "end", "location", "employment_type", "summary"],
  achievement: ["text", "detail", "metrics", "skills"],
  project: ["name", "role", "start", "end", "url", "summary"],
  education: ["institution", "degree", "field", "start", "end", "location", "detail"],
  certification: ["name", "issuer", "date", "expires", "url"],
  skill: ["name", "items"],
  language: ["name", "level"],
  award: ["name", "issuer", "date", "detail"],
};

export const applyAnswersTask: TaskDef<ApplyAnswersInput, ApplyAnswersOutput> = {
  name: "apply-answers",
  schema: ApplyAnswersOutput,
  effort: "medium",
  render: (input) => ({
    input: [
      "## Experience bank",
      bankToPromptText(input.bank),
      "",
      "## Answered questions",
      ...input.answered.map(
        (q) => `${q.id}${q.entry ? ` (about ${q.entry})` : ""}\nQ: ${q.question}\nA: ${q.answer}\n`,
      ),
      "Propose the bank edits these answers support.",
    ].join("\n"),
  }),
  postCheck: (output, input) => {
    const index = indexBank(input.bank);
    const ids = new Set(input.answered.map((q) => q.id));
    const problems: string[] = [];
    for (const c of output.changes) {
      const entry = index.get(c.id);
      if (!entry) problems.push(`change refers to unknown id ${c.id}`);
      else if (!EDITABLE_FIELDS[entry.kind].includes(c.field)) {
        problems.push(
          `${c.id}: field "${c.field}" cannot be changed (allowed: ${EDITABLE_FIELDS[entry.kind].join(", ")})`,
        );
      }
      if (!ids.has(c.question)) problems.push(`change cites unknown question ${c.question}`);
    }
    for (const a of output.additions) {
      if (a.kind === "achievement") {
        const parent = a.parent ? index.get(a.parent) : undefined;
        if (!parent || (parent.kind !== "role" && parent.kind !== "project")) {
          problems.push(
            `new achievement needs an existing role or project as parent (got ${a.parent})`,
          );
        }
      }
      for (const f of a.fields) {
        if (!EDITABLE_FIELDS[a.kind].includes(f.field))
          problems.push(`new ${a.kind}: field "${f.field}" is not allowed`);
      }
    }
    return problems;
  },
};

export type ProposedChange = {
  id: string | null;
  kind: BankKind;
  parent?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  questions: string[];
};

/** Turns the AI proposal into bank ops plus a before/after list the user reviews first. */
export function proposalToOps(
  bank: BankFile,
  output: ApplyAnswersOutput,
): { ops: BankOp[]; changes: ProposedChange[] } {
  const index = indexBank(bank);
  const byId = new Map<string, { after: Record<string, unknown>; questions: Set<string> }>();
  for (const c of output.changes) {
    const entry = index.get(c.id);
    if (!entry) continue;
    const current = byId.get(c.id) ?? {
      after: Object.fromEntries(Object.entries(entry.entry).filter(([k]) => k !== "achievements")),
      questions: new Set<string>(),
    };
    if (c.value === null) delete current.after[c.field];
    else current.after[c.field] = c.value;
    // Changed facts need a fresh look before any CV may use them.
    current.after.confirmed = false;
    current.questions.add(c.question);
    byId.set(c.id, current);
  }
  const ops: BankOp[] = [];
  const changes: ProposedChange[] = [];
  for (const [id, { after, questions }] of byId) {
    const entry = index.get(id);
    if (!entry) continue;
    ops.push({ op: "upsert", kind: entry.kind, entry: after });
    const before = Object.fromEntries(
      Object.entries(entry.entry).filter(([k]) => k !== "achievements"),
    );
    changes.push({ id, kind: entry.kind, before, after, questions: [...questions] });
  }
  for (const a of output.additions) {
    const fields = Object.fromEntries(a.fields.map((f) => [f.field, f.value]));
    const entry = { ...fields, source: "answers", confirmed: false };
    ops.push({ op: "upsert", kind: a.kind, entry, ...(a.parent ? { parent: a.parent } : {}) });
    changes.push({
      id: null,
      kind: a.kind,
      ...(a.parent ? { parent: a.parent } : {}),
      before: null,
      after: entry,
      questions: [a.question],
    });
  }
  return { ops, changes };
}

// ---------- Base CV draft ----------

export const BaseSpec = z.object({
  label: z.string().trim().min(1).max(60),
  track: z.enum(["management", "ic"]),
  target_titles: z.array(z.string().trim().min(1)).max(8).default([]),
  emphasis: z.array(z.string().trim().min(1)).max(8).default([]),
});
export type BaseSpec = z.output<typeof BaseSpec>;

export const DraftBaseOutput = z.object({
  headline: Text,
  /** CV body in the Hirehound CV dialect, without frontmatter. */
  body: Text,
  /** Short note for the user: what was emphasised or left out, and why. */
  notes: z.string(),
});
export type DraftBaseOutput = z.infer<typeof DraftBaseOutput>;

export type DraftBaseInput = {
  spec: BaseSpec;
  bank: BankFile;
  name: string | null;
  maxPages: number;
};

export const draftBaseTask: TaskDef<DraftBaseInput, DraftBaseOutput> = {
  name: "draft-base",
  schema: DraftBaseOutput,
  effort: "high",
  render: (input) => ({
    input: [
      `## Base CV to write`,
      `Label: ${input.spec.label}`,
      `Track: ${input.spec.track === "management" ? "people management" : "individual contributor"}`,
      `Target titles: ${input.spec.target_titles.join(", ") || "(not given)"}`,
      `Emphasis: ${input.spec.emphasis.join(", ") || "(not given)"}`,
      `Length: at most ${input.maxPages} pages`,
      input.name ? `Candidate: ${input.name}` : "",
      "",
      "## Confirmed experience bank (cite only these ids)",
      bankToPromptText(input.bank, { confirmedOnly: true }),
    ].join("\n"),
  }),
  postCheck: (output, input) => {
    const problems: string[] = [];
    const { doc, issues } = parseCv(output.body);
    for (const issue of issues) {
      if (issue.severity === "error") problems.push(`line ${issue.line}: ${issue.message}`);
    }
    const confirmed = new Set(
      [...indexBank(input.bank).values()].filter((e) => e.entry.confirmed).map((e) => e.id),
    );
    for (const issue of checkEvidence(doc, confirmed, "base")) {
      // Base CVs must be fully evidenced too: a missing marker is as bad as a wrong one.
      problems.push(`line ${issue.line}: ${issue.message}`);
    }
    if (doc.blocks.length === 0) problems.push("the CV body is empty");
    return problems;
  },
};
