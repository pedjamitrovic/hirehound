import { z } from "zod";
import { CHECK_IDS } from "../cv/checks.ts";
import { BankId, IsoDateTime, Sha256, Version } from "./common.ts";

export const ClaimVerdict = z.enum(["supported", "weakened", "unsupported"]);

export const VerifiedClaim = z.object({
  /** Claim index in the CV (entry headings, paragraphs and bullets in order). */
  n: z.number().int().min(0),
  line: z.number().int().min(1),
  text: z.string(),
  ev: z.array(BankId),
  /**
   * SHA-256 of the claim text and the content of the entries it cites. A verdict is reused while
   * the key matches, so only claims that changed (or whose evidence changed) are checked again.
   */
  key: Sha256,
  verdict: ClaimVerdict,
  reason: z.string(),
  /** A rewrite the cited entries do support, for weakened and unsupported claims. */
  suggestion: z.string().optional(),
  verified_at: IsoDateTime,
});

export const CheckIssueSchema = z.object({
  check: z.enum(CHECK_IDS),
  n: z.number().int().min(-1),
  line: z.number().int().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
});

export const RenderInfo = z.object({
  /** SHA-256 of cv.pdf as written; approval locks to this exact file. */
  pdf_sha256: Sha256,
  pages: z.number().int().min(0),
  max_pages: z.number().int().min(1),
  rendered_at: IsoDateTime,
  theme: z.string(),
  /** Text extracted back out of the PDF, compared with the CV text (what an ATS would read). */
  ats: z.object({
    /** Share of the CV's words found in the PDF text, 0 to 1. */
    coverage: z.number().min(0).max(1),
    /** A few words that did not come back out, for the report. */
    missing: z.array(z.string()),
    /** Characters that came out as private-use or replacement code points. */
    garbled: z.number().int().min(0),
  }),
});

/** jobs/<id>/verification.json: everything known about one exact version of cv.md. */
export const VerificationFile = z.object({
  version: Version,
  /** SHA-256 of the cv.md text this file describes. Any edit makes it stale. */
  cv_sha256: Sha256,
  bank_sha256: Sha256.nullable(),
  checked_at: IsoDateTime,
  /** The engine that verified claims in this round; null when every verdict was reused. */
  engine: z.object({ id: z.string(), model: z.string() }).nullable(),
  checks: z.array(CheckIssueSchema),
  claims: z.array(VerifiedClaim),
  render: RenderInfo.nullable(),
});

export type ClaimVerdict = z.infer<typeof ClaimVerdict>;
export type VerifiedClaim = z.infer<typeof VerifiedClaim>;
export type RenderInfo = z.infer<typeof RenderInfo>;
export type VerificationFile = z.infer<typeof VerificationFile>;
