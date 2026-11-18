/** Signs of a CAPTCHA or bot check. You solve those yourself; Hirehound never touches them. */
export const CAPTCHA_SELECTOR = [
  "iframe[src*='recaptcha']",
  "iframe[src*='hcaptcha']",
  "iframe[src*='challenges.cloudflare.com']",
  ".g-recaptcha",
  ".h-captcha",
  ".cf-turnstile",
].join(", ");

const SENSITIVE =
  /\b(gender|sex\b|race\b|racial|ethnic|hispanic|latin[oax]|veteran|disab|sexual orientation|lgbt|transgender|pronoun|religio|marital|pregnan|date of birth|birth ?date|age\b|nationality|criminal|conviction|eeo\b|equal (employment|opportunity)|demographic|self-identif)/i;

const CONSENT =
  /\b(i agree|agree to|consent|terms|privacy (policy|notice)|acknowledg|i certify|certify that|i confirm|data (processing|retention))/i;

/** Questions never answered without asking you first: EEO, health, demographics, history. */
export function isSensitiveQuestion(label: string): boolean {
  return SENSITIVE.test(label);
}

/** Accepting terms, giving consent or certifying something is always your own decision. */
export function isConsentQuestion(label: string): boolean {
  return CONSENT.test(label);
}
