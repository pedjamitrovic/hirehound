type Path = (string | number)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keys present in `input` but missing from `parsed`. Zod objects strip unknown keys, so these
 * are typos or unsupported settings in a hand-edited file. Reported as warnings, never errors.
 */
export function strippedKeys(input: unknown, parsed: unknown, path: Path = []): Path[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    const found: Path[] = [];
    const length = Math.min(input.length, parsed.length);
    for (let i = 0; i < length; i++) {
      found.push(...strippedKeys(input[i], parsed[i], [...path, i]));
    }
    return found;
  }
  if (!isPlainObject(input) || !isPlainObject(parsed)) return [];
  const found: Path[] = [];
  for (const key of Object.keys(input)) {
    if (!(key in parsed)) found.push([...path, key]);
    else found.push(...strippedKeys(input[key], parsed[key], [...path, key]));
  }
  return found;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}
