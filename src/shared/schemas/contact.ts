import { z } from "zod";
import { Version } from "./common.ts";

/**
 * The CV header (name, contact line) is rendered from this file, never from CV Markdown,
 * so there is exactly one source of truth for contact details.
 */
export const Contact = z.object({
  version: Version,
  name: z.string().min(1),
  email: z.email(),
  phone: z.string().optional(),
  /** "Belgrade, Serbia" */
  location: z.string().optional(),
  links: z
    .array(
      z.object({
        /** "LinkedIn", "GitHub", "Website" */
        label: z.string().min(1),
        url: z.url(),
      }),
    )
    .default([]),
});

export type Contact = z.infer<typeof Contact>;
