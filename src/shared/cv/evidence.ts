import type { CvDoc, ParseIssue } from "./types.ts";

type Claim = { kind: "Entry heading" | "Paragraph" | "Bullet"; ev: string[]; line: number };

/** Every block that makes a claim: entry headings, paragraphs and bullets, in document order. */
function claims(doc: CvDoc): Claim[] {
  const found: Claim[] = [];
  for (const block of doc.blocks) {
    if (block.t === "entry") found.push({ kind: "Entry heading", ev: block.ev, line: block.line });
    else if (block.t === "paragraph") {
      found.push({ kind: "Paragraph", ev: block.ev, line: block.line });
    } else if (block.t === "list") {
      for (const item of block.items) found.push({ kind: "Bullet", ev: item.ev, line: item.line });
    }
  }
  return found;
}

/** Experience-bank ids cited anywhere in the CV, each once, in order of first appearance. */
export function cvEvidenceIds(doc: CvDoc): string[] {
  const ids = new Set<string>();
  for (const claim of claims(doc)) for (const id of claim.ev) ids.add(id);
  return [...ids];
}

/**
 * Checks evidence markers against the experience bank. Unknown ids are errors in both modes.
 * A missing marker is a warning in a base CV and an error in a tailored CV (guard G1). Section
 * headings never need a marker. Issues point at column 1 of the block's first line.
 */
export function checkEvidence(
  doc: CvDoc,
  knownIds: ReadonlySet<string>,
  mode: "base" | "tailored",
): ParseIssue[] {
  const issues: ParseIssue[] = [];
  for (const claim of claims(doc)) {
    if (claim.ev.length === 0) {
      issues.push({
        line: claim.line,
        col: 1,
        severity: mode === "tailored" ? "error" : "warning",
        message:
          mode === "tailored"
            ? `${claim.kind} has no evidence marker; every claim in a tailored CV cites the experience bank`
            : `${claim.kind} has no evidence marker`,
      });
    }
    for (const id of claim.ev) {
      if (knownIds.has(id)) continue;
      issues.push({
        line: claim.line,
        col: 1,
        severity: "error",
        message: `Unknown evidence id ${id}; it is not in the experience bank`,
      });
    }
  }
  return issues;
}
