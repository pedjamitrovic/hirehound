import { z } from "zod";
import { BaseId, IsoDateTime, Sha256, Version } from "./common.ts";

/** Canonical job states, in pipeline order. Terminal states come last. */
export const JOB_STATES = [
  "found",
  "evaluated",
  "tailoring",
  "ready",
  "approved",
  "applied",
  "screening",
  "interviewing",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "skipped",
  "expired",
] as const;

export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;

export const Actor = z.enum(["user", "system", "ai"]);

export const StatusEvent = z.object({
  at: IsoDateTime,
  /** null for the creation event. */
  from: JobState.nullable(),
  to: JobState,
  by: Actor,
  /** Required for skip, withdraw and external apply. */
  reason: z.string().optional(),
});

export const Note = z.object({
  at: IsoDateTime,
  text: z.string().min(1),
});

export const PersonRole = z.enum([
  "recruiter",
  "hiring-manager",
  "interviewer",
  "referral",
  "other",
]);

export const Person = z.object({
  name: z.string().min(1),
  role: PersonRole,
  email: z.email().optional(),
  phone: z.string().optional(),
  linkedin: z.url().optional(),
  notes: z.string().optional(),
});

/** Written in M3 when the user approves a tailored CV. */
export const Approval = z.object({
  at: IsoDateTime,
  cv_sha256: Sha256,
  base: BaseId,
  /** Set when approved below the score threshold. */
  override_reason: z.string().optional(),
});

/** Written in M4 when the user approves the cover letter; it has its own approval. */
export const CoverLetterApproval = z.object({
  at: IsoDateTime,
  /** SHA-256 of cover-letter.pdf exactly as approved. */
  sha256: Sha256,
});

export const ApplyMethod = z.enum(["manual", "assisted", "external"]);

/** Written in M4, or with method "external" for applications made outside Hirehound. */
export const Application = z.object({
  at: IsoDateTime,
  method: ApplyMethod,
  /** Must equal approval.cv_sha256 unless method is "external". */
  cv_sha256: Sha256.optional(),
  /** Set when a cover letter was sent; must equal cover_letter_approval.sha256. */
  cover_letter_sha256: Sha256.optional(),
});

/** M5: whether the posting is still on its job board, recorded when that changes. */
export const Listing = z.object({
  live: z.boolean(),
  since: IsoDateTime,
});

export const StatusFile = z.object({
  version: Version,
  /** Authoritative; should equal the last history entry's `to`. */
  state: JobState,
  base: BaseId.optional(),
  /** Append-only. */
  history: z.array(StatusEvent).min(1),
  notes: z.array(Note).default([]),
  contacts: z.array(Person).default([]),
  tags: z.array(z.string()).default([]),
  approval: Approval.optional(),
  cover_letter_approval: CoverLetterApproval.optional(),
  application: Application.optional(),
  listing: Listing.optional(),
});

export type Actor = z.infer<typeof Actor>;
export type StatusEvent = z.infer<typeof StatusEvent>;
export type Note = z.infer<typeof Note>;
export type PersonRole = z.infer<typeof PersonRole>;
export type Person = z.infer<typeof Person>;
export type Approval = z.infer<typeof Approval>;
export type CoverLetterApproval = z.infer<typeof CoverLetterApproval>;
export type ApplyMethod = z.infer<typeof ApplyMethod>;
export type Application = z.infer<typeof Application>;
export type Listing = z.infer<typeof Listing>;
export type StatusFile = z.infer<typeof StatusFile>;
