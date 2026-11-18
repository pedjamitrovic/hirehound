import { isMap, isScalar, parseDocument } from "yaml";
import { toYaml } from "../../shared/frontmatter.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Drops undefined values so they never reach YAML as `null`. */
export function compactObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compactObject) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) out[key] = compactObject(v);
  }
  return out as T;
}

/**
 * Writes `value` into existing YAML text while keeping comments and key order of everything that
 * did not change. Maps are merged key by key (keys missing from `value` are removed); arrays and
 * scalars are replaced. A missing or fully commented-out file is written fresh with `header`.
 */
export function updateYamlText(text: string | null, value: unknown, header = ""): string {
  const fresh = () => `${header}${toYaml(compactObject(value))}`;
  if (text === null) return fresh();
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || doc.contents === null || !isMap(doc.contents)) return fresh();

  const apply = (path: string[], next: unknown) => {
    const current = path.length ? doc.getIn(path, true) : doc.contents;
    if (isPlainObject(next) && isMap(current)) {
      for (const [key, v] of Object.entries(next)) {
        if (v === undefined) doc.deleteIn([...path, key]);
        else apply([...path, key], v);
      }
      for (const pair of [...current.items]) {
        const key = String((pair.key as { value?: unknown } | null)?.value ?? pair.key);
        if (!(key in next) || next[key] === undefined) doc.deleteIn([...path, key]);
      }
      return;
    }
    const isScalarValue = next === null || ["string", "number", "boolean"].includes(typeof next);
    if (isScalarValue && isScalar(current)) {
      // Mutating the node (instead of replacing it) keeps its inline comment.
      current.value = next;
      return;
    }
    doc.setIn(path, doc.createNode(compactObject(next)));
  };
  apply([], value);
  return doc.toString({ lineWidth: 0 });
}
