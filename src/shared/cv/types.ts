// AST of the CV Markdown dialect. docs/cv-dialect.md is the source of truth; keep them in sync.

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "section"; text: Inline[]; line: number }
  | { t: "entry"; text: Inline[]; ev: string[]; line: number }
  | { t: "paragraph"; text: Inline[]; ev: string[]; line: number }
  | { t: "list"; items: { text: Inline[]; ev: string[]; line: number }[] }
  | { t: "comment"; v: string; line: number };

export type CvDoc = { frontmatter: Record<string, unknown>; blocks: Block[] };

/** `line` and `col` are 1-based positions in the original file, frontmatter included. */
export type ParseIssue = {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
};

/** One bullet of a list block. */
export type ListItem = Extract<Block, { t: "list" }>["items"][number];
