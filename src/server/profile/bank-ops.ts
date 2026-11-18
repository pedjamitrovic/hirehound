import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { IdAllocator, indexBank } from "../../shared/bank.ts";
import {
  Achievement,
  Award,
  BANK_PREFIXES,
  BankFile,
  type BankKind,
  Certification,
  Education,
  Language,
  Project,
  Role,
  SkillGroup,
} from "../../shared/schemas/bank.ts";
import { formatPath } from "../../shared/validate.ts";
import { HttpError } from "../http/router.ts";
import { compactObject } from "../workspace/yaml-edit.ts";

export const BANK_HEADER = `# Experience bank: every claim a CV makes cites an id from this file (ROLE-003, ACH-014, ...).
# Ids are permanent and never reused. Edit in Hirehound (Profile) or by hand.
# Entries with confirmed: false were drafted by AI and are not used in CVs until you confirm them.
`;

const LIST_KEY: Record<Exclude<BankKind, "achievement">, keyof BankFile> = {
  role: "roles",
  project: "projects",
  education: "education",
  certification: "certifications",
  skill: "skills",
  language: "languages",
  award: "awards",
};

const SCHEMA: Record<BankKind, z.ZodType> = {
  role: Role,
  achievement: Achievement,
  project: Project,
  education: Education,
  certification: Certification,
  skill: SkillGroup,
  language: Language,
  award: Award,
};

const Kind = z.enum(Object.keys(BANK_PREFIXES) as [BankKind, ...BankKind[]]);

export const BankOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    kind: Kind,
    /** Without `id` a new entry is created and gets the next free id. */
    entry: z.record(z.string(), z.unknown()),
    /** Required for new achievements: the role or project they belong to. */
    parent: z.string().optional(),
  }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("confirm"), ids: z.array(z.string()).min(1), confirmed: z.boolean() }),
]);
export type BankOp = z.infer<typeof BankOp>;

type Path = (string | number)[];

function pathOf(bank: BankFile, id: string): Path | null {
  for (const key of ["roles", "projects"] as const) {
    for (const [i, entry] of bank[key].entries()) {
      if (entry.id === id) return [key, i];
      const j = entry.achievements.findIndex((a) => a.id === id);
      if (j >= 0) return [key, i, "achievements", j];
    }
  }
  for (const key of ["education", "certifications", "skills", "languages", "awards"] as const) {
    const i = bank[key].findIndex((e) => e.id === id);
    if (i >= 0) return [key, i];
  }
  return null;
}

/** Empty arrays and undefined add noise to a hand-readable file; leave them out. */
function tidy(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(compactObject(entry))) {
    if (Array.isArray(value) && value.length === 0 && key !== "items") continue;
    if (value === "") continue;
    out[key] = value;
  }
  return out;
}

function validateEntry(kind: BankKind, entry: Record<string, unknown>): Record<string, unknown> {
  const result = SCHEMA[kind].safeParse(entry);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: formatPath(i.path),
      message: i.message,
    }));
    const first = issues[0];
    throw new HttpError(
      400,
      "invalid-entry",
      first ? `${first.path || kind}: ${first.message}` : "Invalid entry",
      issues,
    );
  }
  return entry;
}

function emptyDocument(): Document {
  return parseDocument(`${BANK_HEADER}version: 1\nid_counters: {}\n`);
}

export function parseBankText(text: string | null): { doc: Document; bank: BankFile } {
  const doc = text === null || text.trim() === "" ? emptyDocument() : parseDocument(text);
  if (doc.errors.length > 0) {
    throw new HttpError(
      409,
      "bank-invalid",
      "experience-bank.yaml has YAML errors. Fix the file first.",
    );
  }
  const parsed = BankFile.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(
      409,
      "bank-invalid",
      `experience-bank.yaml is invalid${first ? ` (${formatPath(first.path)}: ${first.message})` : ""}. Fix the file first.`,
    );
  }
  return { doc, bank: parsed.data };
}

/**
 * Applies edits to the bank file text through the YAML document model, so comments and the layout
 * of untouched entries survive. Returns the new text, the parsed bank and the ids it created.
 */
export function applyBankOps(
  text: string | null,
  ops: BankOp[],
): { text: string; bank: BankFile; created: string[] } {
  const parsed = parseBankText(text);
  const { doc } = parsed;
  let bank = parsed.bank;
  const ids = new IdAllocator(bank);
  const created: string[] = [];

  const reparse = () => {
    const parsed = BankFile.safeParse(doc.toJS() ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new HttpError(
        400,
        "invalid-entry",
        first ? `${formatPath(first.path)}: ${first.message}` : "Invalid bank",
      );
    }
    bank = parsed.data;
  };

  for (const op of ops) {
    if (op.op === "delete") {
      const path = pathOf(bank, op.id);
      if (!path) throw new HttpError(404, "entry-not-found", `No entry ${op.id}`);
      doc.deleteIn(path);
      reparse();
      continue;
    }
    if (op.op === "confirm") {
      for (const id of op.ids) {
        const path = pathOf(bank, id);
        if (!path) throw new HttpError(404, "entry-not-found", `No entry ${id}`);
        doc.setIn([...path, "confirmed"], op.confirmed);
      }
      reparse();
      continue;
    }

    const { kind } = op;
    const prefix = BANK_PREFIXES[kind];
    const existingId = typeof op.entry.id === "string" ? op.entry.id : undefined;
    if (existingId) {
      const path = pathOf(bank, existingId);
      const current = indexBank(bank).get(existingId);
      if (!path || !current) throw new HttpError(404, "entry-not-found", `No entry ${existingId}`);
      if (current.kind !== kind) {
        throw new HttpError(
          400,
          "kind-mismatch",
          `${existingId} is a ${current.kind}, not a ${kind}`,
        );
      }
      // Roles and projects keep their achievements; those are edited one by one.
      const next = tidy({ ...op.entry, id: existingId });
      delete next.achievements;
      const nested = (current.entry as { achievements?: unknown }).achievements;
      validateEntry(kind, nested ? { ...next, achievements: nested } : next);
      const node = doc.getIn(path, true);
      if (isMap(node)) {
        for (const pair of [...node.items]) {
          const key = String((pair.key as { value?: unknown } | null)?.value ?? pair.key);
          if (key !== "achievements" && !(key in next)) doc.deleteIn([...path, key]);
        }
        for (const [key, value] of Object.entries(next)) {
          if (key === "achievements") continue;
          const current = node.get(key, true);
          if (isScalar(current) && !Array.isArray(value) && typeof value !== "object") {
            // Mutate in place so an inline comment on the value survives.
            current.value = value;
          } else if (node.has(key)) {
            node.set(key, doc.createNode(value));
          } else {
            // New fields go before the achievements list, where a reader expects them.
            const at = node.items.findIndex(
              (p) =>
                String((p.key as { value?: unknown } | null)?.value ?? p.key) === "achievements",
            );
            const pair = doc.createPair(key, value);
            if (at >= 0) node.items.splice(at, 0, pair);
            else node.items.push(pair);
          }
        }
      } else {
        doc.setIn(path, doc.createNode(next));
      }
      reparse();
      continue;
    }

    const id = ids.next(prefix);
    const next = tidy({ id, ...op.entry, confirmed: op.entry.confirmed ?? false });
    validateEntry(kind, next);
    if (kind === "achievement") {
      if (!op.parent)
        throw new HttpError(400, "parent-required", "New achievements need a role or project");
      const parentPath = pathOf(bank, op.parent);
      const parentKind = indexBank(bank).get(op.parent)?.kind;
      if (!parentPath || (parentKind !== "role" && parentKind !== "project")) {
        throw new HttpError(404, "entry-not-found", `No role or project ${op.parent}`);
      }
      const listPath = [...parentPath, "achievements"];
      if (isSeq(doc.getIn(listPath, true))) doc.addIn(listPath, doc.createNode(next));
      else doc.setIn(listPath, doc.createNode([next]));
    } else {
      const listKey = LIST_KEY[kind];
      if (isSeq(doc.getIn([listKey], true))) doc.addIn([listKey], doc.createNode(next));
      else doc.setIn([listKey], doc.createNode([next]));
    }
    created.push(id);
    reparse();
  }

  doc.setIn(["id_counters"], doc.createNode(ids.counters()));
  reparse();
  return { text: doc.toString({ lineWidth: 0 }), bank, created };
}

export type DraftEntry = {
  kind: Exclude<BankKind, "achievement">;
  /** Caller-chosen key, returned with the assigned id (e.g. to resolve AI question references). */
  ref: string;
  entry: Record<string, unknown>;
  achievements?: { ref: string; entry: Record<string, unknown> }[];
};

/**
 * Appends new entries (an AI draft from imported files) with fresh ids. Existing entries are never
 * touched. Every appended entry is unconfirmed until the user reviews it.
 */
export function appendEntries(
  text: string | null,
  drafts: DraftEntry[],
): { text: string; bank: BankFile; ids: Map<string, string> } {
  const { doc, bank } = parseBankText(text);
  const ids = new IdAllocator(bank);
  const refs = new Map<string, string>();
  for (const draft of drafts) {
    const id = ids.next(BANK_PREFIXES[draft.kind]);
    refs.set(draft.ref, id);
    const achievements = (draft.achievements ?? []).map((a) => {
      const achievementId = ids.next("ACH");
      refs.set(a.ref, achievementId);
      return tidy({ id: achievementId, ...a.entry, confirmed: false });
    });
    const next = tidy({
      id,
      ...draft.entry,
      ...(achievements.length ? { achievements } : {}),
      confirmed: false,
    });
    validateEntry(draft.kind, next);
    const listKey = LIST_KEY[draft.kind];
    if (isSeq(doc.getIn([listKey], true))) doc.addIn([listKey], doc.createNode(next));
    else doc.setIn([listKey], doc.createNode([next]));
  }
  doc.setIn(["id_counters"], doc.createNode(ids.counters()));
  const parsed = BankFile.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(
      400,
      "invalid-entry",
      first ? `${formatPath(first.path)}: ${first.message}` : "Invalid draft",
    );
  }
  return { text: doc.toString({ lineWidth: 0 }), bank: parsed.data, ids: refs };
}

/** Serialises a complete bank (e.g. the first AI draft) as a fresh, tidy file. */
export function bankToYaml(bank: BankFile): string {
  const tidyList = <T extends Record<string, unknown>>(list: T[]) =>
    list.map((entry) => {
      const out = tidy(entry);
      if (Array.isArray(entry.achievements) && entry.achievements.length) {
        out.achievements = (entry.achievements as Record<string, unknown>[]).map(tidy);
      }
      return out;
    });
  const body: Record<string, unknown> = { version: 1, id_counters: bank.id_counters };
  for (const key of [
    "roles",
    "projects",
    "education",
    "certifications",
    "skills",
    "languages",
    "awards",
  ] as const) {
    if (bank[key].length) body[key] = tidyList(bank[key] as Record<string, unknown>[]);
  }
  const doc = parseDocument("");
  doc.contents = doc.createNode(body) as typeof doc.contents;
  return `${BANK_HEADER}${doc.toString({ lineWidth: 0 })}`;
}
