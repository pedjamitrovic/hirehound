const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Latin letters that Unicode normalisation does not decompose into an ASCII base letter. */
const FOLD: Record<string, string> = {
  đ: "dj",
  ł: "l",
  ø: "o",
  ß: "ss",
  æ: "ae",
  œ: "oe",
  þ: "th",
  ı: "i",
};

/** 32-bit FNV-1a, hex. Used to name things whose text has no ASCII letters at all. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Lowercase ASCII slug that is safe as a path segment on Windows, macOS and Linux.
 * Diacritics are folded ("Zürich" becomes "zurich"); text with no usable
 * characters at all (e.g. only Cyrillic) becomes "x-<hash>" so it stays stable and unique.
 */
export function slugify(input: string, maxLength = 48): string {
  let slug = input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[đłøßæœþı]/g, (ch) => FOLD[ch] ?? ch)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug.length > maxLength) {
    // Prefer cutting at a word boundary, unless that would throw away more than half.
    const boundary = slug[maxLength] === "-" ? maxLength : slug.lastIndexOf("-", maxLength);
    const end = boundary > maxLength / 2 ? boundary : maxLength;
    slug = slug.slice(0, end).replace(/-+$/g, "");
  }
  if (slug === "") slug = `x-${fnv1a(input.trim())}`;
  if (WINDOWS_RESERVED.test(slug)) slug = `${slug}-x`;
  return slug;
}

export const COMPANY_SLUG_MAX = 30;
export const ROLE_SLUG_MAX = 48;

/** Job folder name: <YYYY-MM-DD>_<company>_<role>, with "-2", "-3", ... on collision. */
export function jobIdFor(date: string, company: string, title: string, attempt = 1): string {
  const base = `${date}_${slugify(company, COMPANY_SLUG_MAX)}_${slugify(title, ROLE_SLUG_MAX)}`;
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
