import { z } from "zod";
import { BaseId, IsoDateTime, JobId, Sha256 } from "./common.ts";

/** Frontmatter of CV Markdown files. The body dialect is described in docs/cv-dialect.md. */

export const CvTheme = z.enum(["classic", "modern"]);
export type CvTheme = z.infer<typeof CvTheme>;

/** profile/bases/<id>.md */
export const BaseCvFrontmatter = z.object({
  /** Equals the file stem: em.md -> "em". */
  id: BaseId,
  label: z.string().min(1),
  track: z.enum(["management", "ic"]),
  target_titles: z.array(z.string()).default([]),
  headline: z.string().optional(),
  emphasis: z.array(z.string()).default([]),
  theme: CvTheme.default("classic"),
});
export type BaseCvFrontmatter = z.infer<typeof BaseCvFrontmatter>;

/** jobs/<id>/cv.md */
export const TailoredCvFrontmatter = z.object({
  job: JobId,
  base: BaseId,
  /** SHA-256 of the base file the CV was tailored from; cv.base.md is the copy. */
  base_sha256: Sha256,
  headline: z.string().optional(),
  generated_at: IsoDateTime,
  engine: z.object({ id: z.string(), model: z.string() }),
  theme: CvTheme.default("classic"),
});
export type TailoredCvFrontmatter = z.infer<typeof TailoredCvFrontmatter>;
