import { isMap, isNode, isScalar, LineCounter, parseDocument } from "yaml";
import type { z } from "zod";
import type { Diagnostic } from "../../shared/schemas/api.ts";
import { formatPath, strippedKeys } from "../../shared/validate.ts";

export type Parsed<T> = {
  /** null when the YAML is empty/commented out, unparseable, or fails the schema. */
  value: T | null;
  /** The document has no content (missing or fully commented out). */
  empty: boolean;
  diagnostics: Diagnostic[];
};

type Options = {
  /** Workspace-relative path for diagnostics. */
  file: string;
  /** Lines before the YAML starts in the file (frontmatter), so reported lines match the file. */
  lineOffset?: number;
};

/**
 * Parses YAML and validates it, turning every problem into a line-numbered diagnostic.
 * Never throws for bad content: one broken file must not take the app down.
 */
export function parseYaml<T>(text: string, schema: z.ZodType<T>, options: Options): Parsed<T> {
  const { file } = options;
  const offset = options.lineOffset ?? 0;
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  const diagnostics: Diagnostic[] = [];
  const lineAt = (pos: number | undefined) =>
    pos === undefined ? undefined : counter.linePos(pos).line + offset;

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      diagnostics.push({
        file,
        severity: "error",
        message: `YAML syntax: ${error.message.split("\n")[0]}`,
        ...withLine(lineAt(error.pos[0])),
      });
    }
    return { value: null, empty: false, diagnostics };
  }

  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined) return { value: null, empty: true, diagnostics };

  /** Line of the key that holds `keys` (e.g. the "location:" line), when it is a map entry. */
  const keyLine = (keys: (string | number)[]): number | undefined => {
    const parentKeys = keys.slice(0, -1);
    const parent = parentKeys.length ? doc.getIn(parentKeys, true) : doc.contents;
    if (!isMap(parent)) return undefined;
    const last = keys.at(-1);
    const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
    return isNode(pair?.key) ? lineAt(pair.key.range?.[0]) : undefined;
  };

  /** Where to point a problem at `path`; a missing key points at its parent's key. */
  const nodeLine = (path: readonly PropertyKey[]): number | undefined => {
    const keys = path.filter((p): p is string | number => typeof p !== "symbol");
    for (let depth = keys.length; depth >= 1; depth--) {
      const sub = keys.slice(0, depth);
      const node: unknown = doc.getIn(sub, true);
      if (node === undefined) continue;
      if (depth === keys.length && isScalar(node)) return lineAt(node.range?.[0]);
      const line = keyLine(sub);
      if (line !== undefined) return line;
      if (isNode(node)) return lineAt(node.range?.[0]);
    }
    return isNode(doc.contents) ? lineAt(doc.contents.range?.[0]) : undefined;
  };

  const result = schema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = formatPath(issue.path);
      diagnostics.push({
        file,
        severity: "error",
        message: where ? `${where}: ${issue.message}` : issue.message,
        ...withLine(nodeLine(issue.path)),
      });
    }
    return { value: null, empty: false, diagnostics };
  }

  for (const path of strippedKeys(raw, result.data)) {
    diagnostics.push({
      file,
      severity: "warning",
      message: `${formatPath(path)}: unknown setting, ignored`,
      ...withLine(nodeLine(path)),
    });
  }
  return { value: result.data, empty: false, diagnostics };
}

function withLine(line: number | undefined): { line?: number } {
  return line === undefined ? {} : { line };
}
