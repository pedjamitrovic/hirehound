import { z } from "zod";
import { BankId, BaseId, IsoDateTime, SalaryRange, Sha256, Version } from "./common.ts";

export const RequirementWeight = z.enum(["must", "strong", "nice"]);
/** How we know something is a requirement. Estimates can never carry a role into the top band. */
export const RequirementSource = z.enum(["jd-wording", "jd-structure", "estimate"]);
export const RequirementMatch = z.enum(["met", "partial", "gap"]);

export const Requirement = z
  .object({
    /** "R1" */
    id: z.string().min(1),
    text: z.string().min(1),
    weight: RequirementWeight,
    source: RequirementSource,
    /** Verbatim JD snippet when source is jd-wording. */
    quote: z.string().optional(),
    match: RequirementMatch,
    /** Bank entries supporting the match. Must be empty exactly when match is gap. */
    evidence: z.array(BankId),
    note: z.string().optional(),
  })
  .refine((r) => (r.match === "gap") === (r.evidence.length === 0), {
    message: "evidence must be empty exactly when match is gap",
    path: ["evidence"],
  });

/** The contract the evaluate task's model output must satisfy (blocks A to G). */
export const EvaluationOutput = z.object({
  /** A: role summary. */
  summary: z.object({
    text: z.string().min(1),
    /** e.g. "EM title, about 50% hands-on". */
    hidden_signals: z.array(z.string()),
  }),
  /** B: fit. The score is computed in code from the matrix, never by the model. */
  fit: z.object({
    requirements: z.array(Requirement).min(1),
    rationale: z.string(),
  }),
  /** C: level and base profile choice. */
  level: z.object({
    base: BaseId,
    rationale: z.string(),
  }),
  /** D: compensation signal. */
  compensation: z.object({
    basis: z.enum(["stated", "estimated", "unknown"]),
    range: SalaryRange.nullable(),
    note: z.string(),
  }),
  /** E: work authorisation and location. */
  work_authorization: z.object({
    status: z.enum(["compatible", "needs-sponsorship", "incompatible", "unclear"]),
    location_fit: z.enum(["fits", "partial", "no-fit", "unclear"]),
    note: z.string(),
  }),
  /** F: legitimacy. */
  legitimacy: z.object({
    live: z.enum(["live", "closed", "unknown"]),
    repost: z.enum(["no", "likely", "unknown"]),
    ghost_signals: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
  }),
  /** G: recommendation. */
  recommendation: z.object({
    verdict: z.enum(["apply", "stretch", "skip"]),
    /** One line. */
    reason: z.string().min(1),
  }),
});

export const ScoreBand = z.enum(["strong", "good", "stretch", "weak"]);

/** Frontmatter of jobs/<id>/evaluation.md: the model output plus computed and provenance fields. */
export const EvaluationFrontmatter = EvaluationOutput.extend({
  version: Version,
  score: z.number().int().min(0).max(100),
  band: ScoreBand,
  engine: z.object({ id: z.string(), model: z.string() }),
  created_at: IsoDateTime,
  /** Lets the UI mark the evaluation stale when the posting or bank changes. */
  posting_sha256: Sha256,
  bank_sha256: Sha256,
});

export type RequirementWeight = z.infer<typeof RequirementWeight>;
export type RequirementSource = z.infer<typeof RequirementSource>;
export type RequirementMatch = z.infer<typeof RequirementMatch>;
export type Requirement = z.infer<typeof Requirement>;
export type EvaluationOutput = z.infer<typeof EvaluationOutput>;
export type ScoreBand = z.infer<typeof ScoreBand>;
export type EvaluationFrontmatter = z.infer<typeof EvaluationFrontmatter>;
