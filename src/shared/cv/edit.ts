import type { ClaimKind } from "./claims.ts";
import { ESCAPABLE } from "./syntax.ts";

const MARKER_AT_END = /(<!--\s*ev:[^>]*-->)\s*$/;
const BLOCK_START = /^(\s*[-*+]\s|#{1,6}\s|<!--)/;

/** Escapes text so the CV parser reads it back literally (no accidental bold, links or HTML). */
export function escapeCvText(text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ").trim()) out += ESCAPABLE.includes(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * Replaces the text of the claim that starts on `line` (1-based) with `replacement`, keeping its
 * kind (bullet, entry heading or paragraph) and its evidence marker. Continuation lines of the old
 * claim are removed. Returns null when the line does not hold a claim of that kind.
 */
export function replaceClaimText(
  source: string,
  line: number,
  kind: ClaimKind,
  replacement: string,
): string | null {
  const lines = source.split("\n");
  const start = line - 1;
  const first = lines[start];
  if (first === undefined || !first.trim()) return null;
  if (kind === "bullet" && !/^\s*[-*+]\s/.test(first)) return null;
  if (kind === "entry" && !/^###\s/.test(first)) return null;
  let end = start;
  while (!MARKER_AT_END.test(lines[end] ?? "")) {
    const next = lines[end + 1];
    if (next === undefined || !next.trim() || BLOCK_START.test(next)) break;
    end++;
  }
  const marker = MARKER_AT_END.exec(lines[end] ?? "")?.[1];
  const prefix = kind === "bullet" ? "- " : kind === "entry" ? "### " : "";
  lines.splice(
    start,
    end - start + 1,
    `${prefix}${escapeCvText(replacement)}${marker ? ` ${marker}` : ""}`,
  );
  return lines.join("\n");
}
