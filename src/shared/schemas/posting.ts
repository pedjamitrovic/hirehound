import { z } from "zod";
import { EMPLOYMENT_TYPES, POSTING_SOURCES, WORKPLACES } from "../enums.ts";
import { IsoDate, IsoDateTime, SalaryRange, Sha256, Version } from "./common.ts";

export const PostingSource = z.enum(POSTING_SOURCES);
export const Workplace = z.enum(WORKPLACES);
export const EmploymentType = z.enum(EMPLOYMENT_TYPES);

/** Frontmatter of jobs/<id>/posting.md. The body is the posting as readable text. */
export const PostingFrontmatter = z.object({
  version: Version,
  company: z.string().min(1),
  title: z.string().min(1),
  /** Absent for pasted text without a link. */
  url: z.url().optional(),
  source: PostingSource,
  /** ATS job id; the dedupe key for discovery. */
  source_ref: z.string().optional(),
  location: z.string().optional(),
  workplace: Workplace.default("unknown"),
  employment_type: EmploymentType.default("unknown"),
  /** Only when stated in the posting. */
  salary: SalaryRange.optional(),
  posted_at: IsoDate.optional(),
  /** Last day the posting accepts applications, when stated. */
  valid_through: IsoDate.optional(),
  fetched_at: IsoDateTime,
  /** Hash of the normalised body text: change and repost detection. */
  text_sha256: Sha256,
});

export type PostingSource = z.infer<typeof PostingSource>;
export type Workplace = z.infer<typeof Workplace>;
export type EmploymentType = z.infer<typeof EmploymentType>;
export type PostingFrontmatter = z.infer<typeof PostingFrontmatter>;
