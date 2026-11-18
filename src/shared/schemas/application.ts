import { z } from "zod";
import { IsoDateTime, Sha256, Version } from "./common.ts";

export const AnswerSource = z.enum(["profile", "library", "job", "you", "document"]);

/** One question on the form and what was answered. */
export const UsedAnswer = z.object({
  question: z.string().min(1),
  answer: z.string(),
  /** Where the answer came from: contact details, the answers library, typed by you, a file. */
  source: AnswerSource,
  /** The answers.yaml id, when it came from the library. */
  answer_id: z.string().optional(),
});

export const Confirmation = z.object({
  captured_at: IsoDateTime,
  url: z.string().optional(),
  title: z.string().optional(),
  /** Confirmation page or email text, as captured or pasted. */
  text: z.string().optional(),
  /** Screenshot of the confirmation page in the job folder (assisted mode). */
  screenshot: z.string().optional(),
});

/** Frontmatter of jobs/<id>/application.md: the permanent record of what was sent. */
export const ApplicationFile = z.object({
  version: Version,
  applied_at: IsoDateTime,
  method: z.enum(["manual", "assisted"]),
  /** Where the application was made. */
  url: z.string().optional(),
  cv: z.object({ file: z.string(), sha256: Sha256 }),
  cover_letter: z.object({ file: z.string(), sha256: Sha256 }).optional(),
  answers: z.array(UsedAnswer).default([]),
  confirmation: Confirmation.optional(),
});

export type AnswerSource = z.infer<typeof AnswerSource>;
export type UsedAnswer = z.infer<typeof UsedAnswer>;
export type Confirmation = z.infer<typeof Confirmation>;
export type ApplicationFile = z.infer<typeof ApplicationFile>;
