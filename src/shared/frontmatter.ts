import { stringify } from "yaml";

export type FrontmatterSplit = {
  /** Raw YAML between the `---` fences, or null when the file has no frontmatter. */
  yaml: string | null;
  body: string;
  /** 1-based line of the first YAML line, for mapping parse errors back to the file. */
  yamlStartLine: number;
};

const FENCE = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/;

/** Normalises CRLF and a leading BOM so every parser sees LF-only text. */
export function normalizeText(text: string): string {
  return text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  const normalized = normalizeText(text);
  const match = FENCE.exec(normalized);
  if (!match) return { yaml: null, body: normalized, yamlStartLine: 0 };
  return {
    yaml: match[1] ?? "",
    body: normalized.slice(match[0].length).replace(/^\n+/, ""),
    yamlStartLine: 2,
  };
}

/** YAML as the app writes it: no line folding, LF, trailing newline. */
export function toYaml(data: unknown): string {
  return stringify(data, { lineWidth: 0 });
}

export function joinFrontmatter(data: unknown, body: string): string {
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\n${toYaml(data)}---\n\n${trimmedBody}\n`;
}
