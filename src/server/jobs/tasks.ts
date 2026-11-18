import { z } from "zod";
import { bankToPromptText, type IndexedEntry, indexBank } from "../../shared/bank.ts";
import { checkTailoredCv } from "../../shared/cv/checks.ts";
import { type Claim, cvClaims } from "../../shared/cv/claims.ts";
import { parseCv } from "../../shared/cv/parse.ts";
import { toYaml } from "../../shared/frontmatter.ts";
import type { BankFile } from "../../shared/schemas/bank.ts";
import type { EvaluationOutput } from "../../shared/schemas/evaluation.ts";
import type { PostingFrontmatter } from "../../shared/schemas/posting.ts";
import type { Preferences } from "../../shared/schemas/preferences.ts";
import { ClaimVerdict } from "../../shared/schemas/verification.ts";
import type { TaskDef } from "../ai/run-task.ts";

// Model output contracts use `nullable` for "not stated", like the onboarding tasks: structured
// outputs work best with every field present. They are mapped to the workspace file schemas after.

const Text = z.string().min(1);

// ---------- Shared prompt pieces ----------

const SKIP_KEYS = new Set(["id", "confirmed", "source", "tags", "achievements"]);

function fieldsText(entry: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (SKIP_KEYS.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${indent}${key}: ${value.join("; ")}`);
    } else lines.push(`${indent}${key}: ${String(value).replace(/\s+/g, " ").trim()}`);
  }
  return lines;
}

/**
 * One bank entry with every field, plus the role or project an achievement belongs to. This is
 * exactly what the verifier sees for a citation, and part of each claim's verification key.
 */
export function entryEvidenceText(entry: IndexedEntry, index: Map<string, IndexedEntry>): string {
  const lines = [`${entry.id} (${entry.kind})`];
  lines.push(...fieldsText(entry.entry as Record<string, unknown>, "  "));
  const parent = entry.parent ? index.get(entry.parent) : undefined;
  if (parent) {
    lines.push(`  part of ${parent.id} (${parent.kind}):`);
    lines.push(...fieldsText(parent.entry as Record<string, unknown>, "    "));
  }
  return lines.join("\n");
}

function postingText(posting: PostingFrontmatter | null, body: string): string {
  const p = posting;
  const facts = p
    ? [
        `Company: ${p.company}`,
        `Title: ${p.title}`,
        p.location ? `Location: ${p.location}` : "",
        p.workplace !== "unknown" ? `Workplace: ${p.workplace}` : "",
        p.employment_type !== "unknown" ? `Employment type: ${p.employment_type}` : "",
        p.salary ? `Salary (from the posting): ${p.salary.raw ?? JSON.stringify(p.salary)}` : "",
        p.posted_at ? `Posted: ${p.posted_at}` : "",
        p.valid_through ? `Open until: ${p.valid_through}` : "",
        `Snapshot taken: ${p.fetched_at}`,
      ].filter(Boolean)
    : [];
  return [...facts, "", body.trim()].join("\n");
}

// ---------- Evaluate ----------

const ModelRequirement = z.object({
  id: Text,
  text: Text,
  weight: z.enum(["must", "strong", "nice"]),
  source: z.enum(["jd-wording", "jd-structure", "estimate"]),
  quote: z.string().nullable(),
  match: z.enum(["met", "partial", "gap"]),
  evidence: z.array(z.string()),
  note: z.string().nullable(),
});

export const EvaluateOutput = z.object({
  summary: z.object({ text: Text, hidden_signals: z.array(z.string()) }),
  fit: z.object({ requirements: z.array(ModelRequirement).min(1), rationale: z.string() }),
  level: z.object({ base: Text, rationale: z.string() }),
  compensation: z.object({
    basis: z.enum(["stated", "estimated", "unknown"]),
    min: z.number().nullable(),
    max: z.number().nullable(),
    currency: z.string().nullable(),
    period: z.enum(["year", "month", "day", "hour"]).nullable(),
    raw: z.string().nullable(),
    note: z.string(),
  }),
  work_authorization: z.object({
    status: z.enum(["compatible", "needs-sponsorship", "incompatible", "unclear"]),
    location_fit: z.enum(["fits", "partial", "no-fit", "unclear"]),
    note: z.string(),
  }),
  legitimacy: z.object({
    live: z.enum(["live", "closed", "unknown"]),
    repost: z.enum(["no", "likely", "unknown"]),
    ghost_signals: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
  }),
  recommendation: z.object({ verdict: z.enum(["apply", "stretch", "skip"]), reason: Text }),
});
export type EvaluateOutput = z.infer<typeof EvaluateOutput>;

export type BaseChoice = {
  id: string;
  label: string;
  track: string | null;
  headline: string | null;
  targetTitles: string[];
  emphasis: string[];
};

export type EvaluateInput = {
  posting: PostingFrontmatter | null;
  body: string;
  bank: BankFile;
  bases: BaseChoice[];
  preferences: Preferences | null;
  today: string;
};

export const evaluateTask: TaskDef<EvaluateInput, EvaluateOutput> = {
  name: "evaluate",
  schema: EvaluateOutput,
  effort: "high",
  render: (input) => ({
    input: [
      `Today: ${input.today}`,
      "",
      "## Job posting",
      postingText(input.posting, input.body),
      "",
      "## Candidate preferences",
      input.preferences ? toYaml(input.preferences).trim() : "(not set up)",
      "",
      "## Base CVs (choose one for level.base)",
      ...input.bases.map(
        (b) =>
          `- ${b.id}: ${b.label}${b.track ? ` (${b.track})` : ""}${b.headline ? `, headline "${b.headline}"` : ""}${b.targetTitles.length ? `, targets ${b.targetTitles.join(", ")}` : ""}${b.emphasis.length ? `, emphasis ${b.emphasis.join(", ")}` : ""}`,
      ),
      "",
      "## Confirmed experience bank (cite only these ids)",
      bankToPromptText(input.bank, { confirmedOnly: true }),
      "",
      "Evaluate this posting for the candidate now.",
    ].join("\n"),
  }),
  postCheck: (output, input) => {
    const problems: string[] = [];
    const confirmed = confirmedIds(input.bank);
    const seen = new Set<string>();
    for (const r of output.fit.requirements) {
      if (seen.has(r.id)) problems.push(`requirement id ${r.id} is used twice`);
      seen.add(r.id);
      if ((r.match === "gap") !== (r.evidence.length === 0)) {
        problems.push(`${r.id}: evidence must be empty exactly when match is "gap"`);
      }
      for (const id of r.evidence) {
        if (!confirmed.has(id)) problems.push(`${r.id}: ${id} is not a confirmed bank id`);
      }
      if (r.source === "jd-wording" && !r.quote?.trim()) {
        problems.push(`${r.id}: a jd-wording requirement needs the quote from the posting`);
      }
    }
    if (!input.bases.some((b) => b.id === output.level.base)) {
      problems.push(
        `level.base must be one of: ${input.bases.map((b) => b.id).join(", ")} (got "${output.level.base}")`,
      );
    }
    const c = output.compensation;
    if (c.basis !== "unknown" && !c.currency) problems.push("compensation needs a currency");
    if (c.min !== null && c.max !== null && c.min > c.max) problems.push("compensation min > max");
    return problems;
  },
};

function confirmedIds(bank: BankFile): Set<string> {
  return new Set([...indexBank(bank).values()].filter((e) => e.entry.confirmed).map((e) => e.id));
}

/** The model's answer in the shape of evaluation.md (blocks A to G). */
export function toEvaluation(output: EvaluateOutput): EvaluationOutput {
  const c = output.compensation;
  const currency = c.currency?.trim().toUpperCase() ?? "";
  return {
    summary: output.summary,
    fit: {
      rationale: output.fit.rationale,
      requirements: output.fit.requirements.map((r) => ({
        id: r.id,
        text: r.text,
        weight: r.weight,
        source: r.source,
        ...(r.quote?.trim() ? { quote: r.quote.trim() } : {}),
        match: r.match,
        evidence: r.evidence,
        ...(r.note?.trim() ? { note: r.note.trim() } : {}),
      })),
    },
    level: output.level,
    compensation: {
      basis: c.basis,
      range:
        c.basis !== "unknown" && /^[A-Z]{3}$/.test(currency)
          ? {
              ...(c.min !== null ? { min: c.min } : {}),
              ...(c.max !== null ? { max: c.max } : {}),
              currency,
              period: c.period ?? "year",
              ...(c.raw?.trim() ? { raw: c.raw.trim() } : {}),
            }
          : null,
      note: c.note,
    },
    work_authorization: output.work_authorization,
    legitimacy: output.legitimacy,
    recommendation: output.recommendation,
  };
}

// ---------- Tailor ----------

export const TailorOutput = z.object({
  headline: Text,
  /** The tailored CV body in the Hirehound CV dialect, without frontmatter. */
  body: Text,
  changes: z.array(z.object({ what: Text, why: Text, ev: z.array(z.string()) })),
  notes: z.string(),
});
export type TailorOutput = z.infer<typeof TailorOutput>;

export type TailorInput = {
  posting: PostingFrontmatter | null;
  postingBody: string;
  evaluation: EvaluationOutput | null;
  base: { id: string; label: string; headline: string | null; body: string };
  bank: BankFile;
  maxPages: number;
  /** "Request changes": what the user wants different, and the CV it applies to. */
  feedback?: { text: string; current: string } | undefined;
};

function requirementsText(evaluation: EvaluationOutput | null): string {
  if (!evaluation) return "(no evaluation)";
  return evaluation.fit.requirements
    .map(
      (r) =>
        `- ${r.id} [${r.weight}, ${r.match}] ${r.text}${r.evidence.length ? ` (evidence: ${r.evidence.join(", ")})` : ""}`,
    )
    .join("\n");
}

export const tailorTask: TaskDef<TailorInput, TailorOutput> = {
  name: "tailor",
  schema: TailorOutput,
  effort: "high",
  maxOutputTokens: 32_000,
  lenient: true,
  render: (input) => ({
    input: [
      "## Job posting",
      postingText(input.posting, input.postingBody),
      "",
      "## Requirements from the evaluation",
      requirementsText(input.evaluation),
      input.evaluation ? `\nRole summary: ${input.evaluation.summary.text}` : "",
      "",
      `## Base CV "${input.base.label}" (${input.base.id})`,
      input.base.headline ? `Headline: ${input.base.headline}` : "",
      "",
      input.base.body.trim(),
      "",
      `## Length: at most ${input.maxPages} pages`,
      "",
      "## Confirmed experience bank (cite only these ids)",
      bankToPromptText(input.bank, { confirmedOnly: true }),
      ...(input.feedback
        ? [
            "",
            "## Current tailored CV",
            input.feedback.current.trim(),
            "",
            "## Requested changes (from the candidate)",
            input.feedback.text.trim(),
            "",
            "Revise the current tailored CV as requested, within the rules.",
          ]
        : ["", "Tailor the base CV for this posting now."]),
    ].join("\n"),
  }),
  postCheck: (output, input) => {
    const problems: string[] = [];
    const { doc, issues } = parseCv(output.body);
    for (const issue of issues) {
      if (issue.severity === "error") problems.push(`line ${issue.line}: ${issue.message}`);
    }
    if (cvClaims(doc).length === 0) problems.push("the CV body is empty");
    for (const issue of checkTailoredCv(doc, input.bank).issues) {
      if (issue.severity === "error") problems.push(`line ${issue.line}: ${issue.message}`);
    }
    return problems;
  },
};

// ---------- Verify ----------

export const VerifyOutput = z.object({
  claims: z.array(
    z.object({
      n: z.number().int(),
      verdict: ClaimVerdict,
      reason: Text,
      suggestion: z.string().nullable(),
    }),
  ),
});
export type VerifyOutput = z.infer<typeof VerifyOutput>;

export type VerifyInput = {
  claims: Claim[];
  /** Evidence text per cited id (entryEvidenceText). */
  evidence: Map<string, string>;
};

export const verifyTask: TaskDef<VerifyInput, VerifyOutput> = {
  name: "verify",
  schema: VerifyOutput,
  effort: "high",
  render: (input) => {
    const ids = [...new Set(input.claims.flatMap((c) => c.ev))];
    return {
      input: [
        "## Cited experience-bank entries",
        ...ids.map((id) => input.evidence.get(id) ?? `${id}: (not in the bank)`),
        "",
        "## Claims",
        ...input.claims.map(
          (c) =>
            `[${c.n}] ${c.kind === "entry" ? "Entry heading" : c.kind === "paragraph" ? "Paragraph" : "Bullet"}${c.section ? ` in "${c.section}"` : ""}, cites ${c.ev.join(", ")}\n${c.text}`,
        ),
        "",
        `Give a verdict for each of the ${input.claims.length} claims.`,
      ].join("\n"),
    };
  },
  postCheck: (output, input) => {
    const problems: string[] = [];
    const wanted = new Set(input.claims.map((c) => c.n));
    const seen = new Set<number>();
    for (const c of output.claims) {
      if (!wanted.has(c.n)) problems.push(`claim [${c.n}] does not exist`);
      else if (seen.has(c.n)) problems.push(`claim [${c.n}] is answered twice`);
      seen.add(c.n);
      if (c.verdict !== "supported" && !c.suggestion?.trim()) {
        problems.push(`claim [${c.n}] is ${c.verdict} but has no suggestion`);
      }
    }
    const missing = [...wanted].filter((n) => !seen.has(n));
    if (missing.length)
      problems.push(`no verdict for claims ${missing.map((n) => `[${n}]`).join(", ")}`);
    return problems;
  },
};
