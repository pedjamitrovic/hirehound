import { type Claim, normalizeClaimText } from "./claims.ts";

export type ClaimDiff =
  | { op: "same"; cv: Claim; base: Claim }
  | { op: "changed"; cv: Claim; base: Claim }
  | { op: "added"; cv: Claim }
  | { op: "removed"; base: Claim };

/** Longest common subsequence of two string lists, as index pairs. */
function lcs(a: readonly string[], b: readonly string[]): [number, number][] {
  const cols = b.length + 1;
  const table = new Uint16Array((a.length + 1) * cols);
  const at = (i: number, j: number) => table[i * cols + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return pairs;
}

const sameEvidence = (a: Claim, b: Claim) =>
  a.ev.length === b.ev.length && a.ev.every((id) => b.ev.includes(id));
const shareEvidence = (a: Claim, b: Claim) => a.ev.some((id) => b.ev.includes(id));

/**
 * Claim-level diff of a tailored CV against its base, in tailored-CV order. Claims with the same
 * text (ignoring case and spacing) match. An added claim that cites an entry a removed claim cited
 * is the same fact reworded, possibly moved, and becomes "changed". Removed claims stay where they
 * stood in the base.
 */
export function diffClaims(base: readonly Claim[], cv: readonly Claim[]): ClaimDiff[] {
  const pairs = lcs(
    base.map((c) => normalizeClaimText(c.text)),
    cv.map((c) => normalizeClaimText(c.text)),
  );
  const raw: ClaimDiff[] = [];
  let bi = 0;
  let ci = 0;
  const gap = (bEnd: number, cEnd: number) => {
    for (const claim of base.slice(bi, bEnd)) raw.push({ op: "removed", base: claim });
    for (const claim of cv.slice(ci, cEnd)) raw.push({ op: "added", cv: claim });
  };
  for (const [b, c] of pairs) {
    gap(b, c);
    const baseClaim = base[b];
    const cvClaim = cv[c];
    if (baseClaim && cvClaim) {
      // The same words citing different evidence is still a change worth a look.
      raw.push({
        op: sameEvidence(baseClaim, cvClaim) ? "same" : "changed",
        cv: cvClaim,
        base: baseClaim,
      });
    }
    bi = b + 1;
    ci = c + 1;
  }
  gap(base.length, cv.length);

  const removed = raw.filter((d): d is Extract<ClaimDiff, { op: "removed" }> => d.op === "removed");
  const taken = new Set<ClaimDiff>();
  const rewrites = new Map<ClaimDiff, Claim>();
  for (const d of raw) {
    if (d.op !== "added") continue;
    const free = removed.filter((r) => !taken.has(r));
    const partner =
      free.find((r) => sameEvidence(r.base, d.cv)) ?? free.find((r) => shareEvidence(r.base, d.cv));
    if (partner) {
      taken.add(partner);
      rewrites.set(d, partner.base);
    }
  }
  const out: ClaimDiff[] = [];
  for (const d of raw) {
    if (taken.has(d)) continue;
    const base = d.op === "added" ? rewrites.get(d) : undefined;
    if (d.op !== "added" || !base) out.push(d);
    else {
      // A claim that only moved is not a change.
      const moved =
        normalizeClaimText(base.text) === normalizeClaimText(d.cv.text) && sameEvidence(base, d.cv);
      out.push({ op: moved ? "same" : "changed", cv: d.cv, base });
    }
  }
  return out;
}

export type DiffStats = { same: number; changed: number; added: number; removed: number };

export function diffStats(diff: readonly ClaimDiff[]): DiffStats {
  const stats: DiffStats = { same: 0, changed: 0, added: 0, removed: 0 };
  for (const d of diff) stats[d.op] += 1;
  return stats;
}
