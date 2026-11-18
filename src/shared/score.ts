import type { Requirement, ScoreBand } from "./schemas/evaluation.ts";

const WEIGHT = { must: 3, strong: 2, nice: 1 } as const;
const MATCH = { met: 1, partial: 0.5, gap: 0 } as const;

export const BAND_MIN = { strong: 85, good: 70, stretch: 50 } as const;
/** Highest score reachable when only estimated requirements would carry a role into the top band. */
export const ESTIMATE_CAP = BAND_MIN.strong - 1;
/** Highest score reachable with an unmet must-have. */
export const MUST_GAP_CAP = BAND_MIN.good - 1;

export type ScoreCap = "estimate" | "must-gap";

export type ScoreResult = {
  score: number;
  band: ScoreBand;
  /** Score before caps. */
  raw: number;
  /** Score over requirements stated or structured in the JD (no estimates). */
  firm: number;
  caps: ScoreCap[];
};

type ScoredRequirement = Pick<Requirement, "weight" | "match" | "source">;

function weightedPercent(reqs: readonly ScoredRequirement[]): number {
  let total = 0;
  let earned = 0;
  for (const r of reqs) {
    total += WEIGHT[r.weight];
    earned += WEIGHT[r.weight] * MATCH[r.match];
  }
  return total === 0 ? 0 : Math.round((100 * earned) / total);
}

export function bandFor(score: number): ScoreBand {
  if (score >= BAND_MIN.strong) return "strong";
  if (score >= BAND_MIN.good) return "good";
  if (score >= BAND_MIN.stretch) return "stretch";
  return "weak";
}

/**
 * Deterministic fit score from the requirement matrix (PRD 7.2 B).
 * The model produces the matrix; code produces the number, so it is reproducible and testable.
 */
export function computeScore(requirements: readonly ScoredRequirement[]): ScoreResult {
  const raw = weightedPercent(requirements);
  const firm = weightedPercent(requirements.filter((r) => r.source !== "estimate"));
  const caps: ScoreCap[] = [];
  let score = raw;

  if (firm < BAND_MIN.strong && score > ESTIMATE_CAP) {
    score = ESTIMATE_CAP;
    caps.push("estimate");
  }
  const mustGap = requirements.some((r) => r.weight === "must" && r.match === "gap");
  if (mustGap && score > MUST_GAP_CAP) {
    score = MUST_GAP_CAP;
    caps.push("must-gap");
  }
  return { score, band: bandFor(score), raw, firm, caps };
}
