import { z } from "zod";
import { Version } from "./common.ts";

/**
 * profile/onboarding.yaml: state the onboarding wizard needs between sessions. The facts
 * themselves live in experience-bank.yaml; this only holds the open questions and suggestions.
 */
export const OnboardingQuestion = z.object({
  /** Q-001 */
  id: z.string().regex(/^Q-\d{3,}$/),
  /** Bank entry the question is about, when it is about one. */
  entry: z.string().optional(),
  question: z.string().min(1),
  /** Why it matters for the CV. */
  why: z.string().optional(),
  answer: z.string().optional(),
  status: z.enum(["open", "applied", "skipped"]).default("open"),
});

export const ContactSuggestion = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
});

export const OnboardingFile = z.object({
  version: Version,
  /** Contact details found in the imported files, offered to prefill contact.yaml. */
  contact_suggestion: ContactSuggestion.optional(),
  questions: z.array(OnboardingQuestion).default([]),
});

export type OnboardingQuestion = z.infer<typeof OnboardingQuestion>;
export type ContactSuggestion = z.infer<typeof ContactSuggestion>;
export type OnboardingFile = z.infer<typeof OnboardingFile>;
