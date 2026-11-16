import { z } from "zod";
import { IsoDate, Version } from "./common.ts";

export const Answer = z.object({
  /** Stable key, e.g. "notice-period". */
  id: z.string().regex(/^[a-z0-9-]+$/, "expected a lowercase id like notice-period"),
  /** Canonical phrasing of the question. */
  question: z.string().min(1),
  /** Other phrasings seen on forms; used for matching. */
  aliases: z.array(z.string()).default([]),
  answer: z.string(),
  kind: z.enum(["text", "yes-no", "number", "choice", "url", "date"]).default("text"),
  /** "work-authorization", "salary", "eeo" */
  tags: z.array(z.string()).default([]),
  /** EEO, disability, etc: never filled in without asking first. */
  sensitive: z.boolean().default(false),
  updated_at: IsoDate.optional(),
});

export const AnswersFile = z
  .object({
    version: Version,
    answers: z.array(Answer).default([]),
  })
  .refine((f) => new Set(f.answers.map((a) => a.id)).size === f.answers.length, {
    message: "answer ids must be unique",
    path: ["answers"],
  });

export type Answer = z.infer<typeof Answer>;
export type AnswersFile = z.infer<typeof AnswersFile>;
