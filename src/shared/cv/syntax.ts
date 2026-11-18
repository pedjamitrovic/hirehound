// Pieces of the CV dialect grammar shared by the parser, serializer and renderer.

/** Characters a backslash escapes. Before any other character a backslash is literal text. */
export const ESCAPABLE = "*[]\\<";

/** Experience-bank id as cited in markers; the same pattern as BankId in schemas/common.ts. */
export const EVIDENCE_ID = /^[A-Z]{2,5}-[0-9]{3,}$/;

/**
 * A complete evidence marker. Whitespace is optional everywhere on read (the serializer always
 * writes `<!-- ev: ACH-014, ACH-020 -->`); the id list is captured.
 */
const MARKER =
  /^<!--[ \t]*ev:[ \t]*([A-Z]{2,5}-[0-9]{3,}(?:[ \t]*,[ \t]*[A-Z]{2,5}-[0-9]{3,})*)[ \t]*-->$/;

/** Comment content that is meant as an evidence marker, valid or not. */
const MARKER_LIKE = /^\s*ev\s*:/i;

export function isMarkerLike(commentInner: string): boolean {
  return MARKER_LIKE.test(commentInner);
}

/** Ids of a complete `<!-- ev: ... -->` comment, or null when it is malformed. */
export function markerIds(comment: string): string[] | null {
  const match = MARKER.exec(comment);
  if (!match?.[1]) return null;
  return match[1].split(/[ \t]*,[ \t]*/);
}

export function formatMarker(ids: readonly string[]): string {
  return `<!-- ev: ${ids.join(", ")} -->`;
}

/** Links may point to http, https and mailto targets only. */
export function isAllowedHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)[^\s<>]+$/i.test(href);
}
