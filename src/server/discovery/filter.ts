import type { Portal } from "../../shared/schemas/portals.ts";
import type { Preferences } from "../../shared/schemas/preferences.ts";
import type { DiscoveredPosting } from "./ats.ts";

const norm = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whole-word, case- and accent-insensitive "contains": "Sr. Engineer" contains "engineer". */
export function containsTerm(text: string, term: string): boolean {
  const t = norm(term);
  return t !== "" && ` ${norm(text)} `.includes(` ${t} `);
}

/**
 * Why a scan leaves this posting out, or null to keep it. Portal filters come first, then the hard
 * filters from your preferences. Only facts the posting states count: an unknown workplace or
 * location is never a reason to drop it.
 */
export function filterReason(
  posting: Pick<DiscoveredPosting, "title" | "company" | "location" | "workplace">,
  portal: Pick<Portal, "titles" | "exclude_titles" | "locations"> | null,
  prefs: Preferences | null,
): string | null {
  if (portal?.titles.length && !portal.titles.some((t) => containsTerm(posting.title, t))) {
    return `The title has none of this portal's words (${portal.titles.join(", ")})`;
  }
  const excluded = [
    ...(portal?.exclude_titles ?? []),
    ...(prefs?.roles.exclude_title_keywords ?? []),
  ];
  const word = excluded.find((t) => containsTerm(posting.title, t));
  if (word) return `The title contains "${word}"`;
  if (prefs?.company.exclude_companies.some((c) => norm(c) === norm(posting.company))) {
    return `${posting.company} is excluded in your preferences`;
  }
  if (portal?.locations.length && posting.location) {
    const remoteOk =
      portal.locations.some((l) => norm(l) === "remote") && posting.workplace === "remote";
    if (!remoteOk && !portal.locations.some((l) => containsTerm(posting.location ?? "", l))) {
      return `${posting.location} is not one of this portal's locations (${portal.locations.join(", ")})`;
    }
  }
  if (
    prefs?.location.remote === "remote-only" &&
    (posting.workplace === "onsite" || posting.workplace === "hybrid")
  ) {
    return `It is ${posting.workplace === "onsite" ? "on site" : "hybrid"}; you only want remote roles`;
  }
  return null;
}

/** The key for "same company, same role": lowercase words only. */
export function roleKey(company: string, title: string): string {
  return `${norm(company)}|${norm(title)}`;
}
