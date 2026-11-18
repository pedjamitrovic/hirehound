import type { ClaimDiff } from "../../shared/cv/diff.ts";
import type { EvaluationFrontmatter } from "../../shared/schemas/evaluation.ts";
import type { ScoreResult } from "../../shared/score.ts";

// Human-readable Markdown bodies for job files. The frontmatter (or the CV itself) stays the
// source of truth; these exist so the folder makes sense when opened in an editor.

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function money(range: NonNullable<EvaluationFrontmatter["compensation"]["range"]>): string {
  const n = (v: number) => v.toLocaleString("en");
  const span =
    range.min !== undefined && range.max !== undefined
      ? `${n(range.min)} - ${n(range.max)}`
      : range.min !== undefined
        ? `from ${n(range.min)}`
        : range.max !== undefined
          ? `up to ${n(range.max)}`
          : "";
  return [range.currency, span, `per ${range.period}`].filter(Boolean).join(" ");
}

const CAPS: Record<string, string> = {
  estimate: "capped at 84: estimated requirements cannot carry a role into the top band",
  "must-gap": "capped at 69: a must-have requirement is a gap",
};

export function evaluationMarkdown(
  e: EvaluationFrontmatter,
  score: ScoreResult,
  job: { company: string; title: string },
): string {
  const lines: string[] = [
    `# Evaluation: ${job.title} at ${job.company}`,
    "",
    `**Fit ${score.score}/100 (${score.band})**. Recommendation: **${e.recommendation.verdict}**. ${e.recommendation.reason}`,
  ];
  if (score.caps.length) {
    lines.push("", ...score.caps.map((c) => `- Score ${CAPS[c] ?? c} (raw ${score.raw}).`));
  }
  lines.push("", "## A. Role summary", "", e.summary.text);
  if (e.summary.hidden_signals.length) {
    lines.push("", ...e.summary.hidden_signals.map((s) => `- ${s}`));
  }
  lines.push(
    "",
    "## B. Fit",
    "",
    e.fit.rationale,
    "",
    "| Requirement | Weight | Source | Match | Evidence |",
    "|---|---|---|---|---|",
    ...e.fit.requirements.map(
      (r) =>
        `| ${r.id} ${cell(r.text)}${r.quote ? ` ("${cell(r.quote)}")` : ""}${r.note ? `. ${cell(r.note)}` : ""} | ${r.weight} | ${r.source} | ${r.match} | ${r.evidence.join(", ") || "-"} |`,
    ),
    "",
    "## C. Level and base CV",
    "",
    `Base CV: ${e.level.base}. ${e.level.rationale}`,
    "",
    "## D. Compensation",
    "",
    `${e.compensation.basis}${e.compensation.range ? `: ${money(e.compensation.range)}` : ""}. ${e.compensation.note}`,
    "",
    "## E. Work authorisation and location",
    "",
    `Authorisation: ${e.work_authorization.status}. Location: ${e.work_authorization.location_fit}. ${e.work_authorization.note}`,
    "",
    "## F. Legitimacy",
    "",
    `Live: ${e.legitimacy.live}. Repost: ${e.legitimacy.repost}. Risk: ${e.legitimacy.risk}.`,
  );
  if (e.legitimacy.ghost_signals.length) {
    lines.push("", ...e.legitimacy.ghost_signals.map((s) => `- ${s}`));
  }
  lines.push(
    "",
    "## G. Recommendation",
    "",
    `${e.recommendation.verdict}: ${e.recommendation.reason}`,
    "",
    `_Written ${e.created_at} by ${e.engine.model}. The frontmatter is authoritative; the score is computed from the requirement matrix._`,
  );
  return lines.join("\n");
}

export function changesMarkdown(input: {
  base: { id: string; sha256: string };
  generatedAt: string;
  diff: readonly ClaimDiff[];
  changes: { what: string; why: string; ev: string[] }[];
  notes: string;
  feedback?: string | undefined;
}): string {
  const ev = (ids: readonly string[]) => (ids.length ? ` (${ids.join(", ")})` : "");
  const changed = input.diff.filter((d) => d.op === "changed");
  const added = input.diff.filter((d) => d.op === "added");
  const removed = input.diff.filter((d) => d.op === "removed");
  const lines = [
    `# Changes against base CV "${input.base.id}"`,
    "",
    `Base: profile/bases/${input.base.id}.md (sha256 ${input.base.sha256}), copied to cv.base.md.`,
    `Tailored: ${input.generatedAt}.`,
  ];
  if (input.feedback)
    lines.push("", "Requested changes:", "", `> ${input.feedback.replace(/\n/g, "\n> ")}`);
  lines.push("", "## Why (from the tailoring)", "");
  lines.push(
    ...(input.changes.length
      ? input.changes.map((c) => `- ${c.what}: ${c.why}${ev(c.ev)}`)
      : ["- (none listed)"]),
  );
  if (input.notes.trim()) lines.push("", input.notes.trim());
  lines.push("", `## Changed (${changed.length})`, "");
  for (const d of changed) {
    if (d.op !== "changed") continue;
    lines.push(
      `- line ${d.cv.line}: ${d.cv.text}${ev(d.cv.ev)}`,
      `  - was: ${d.base.text}${ev(d.base.ev)}`,
    );
  }
  lines.push("", `## Added (${added.length})`, "");
  for (const d of added)
    if (d.op === "added") lines.push(`- line ${d.cv.line}: ${d.cv.text}${ev(d.cv.ev)}`);
  lines.push("", `## Removed (${removed.length})`, "");
  for (const d of removed) if (d.op === "removed") lines.push(`- ${d.base.text}${ev(d.base.ev)}`);
  return `${lines.join("\n")}\n`;
}
