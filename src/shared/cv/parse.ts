import { LineCounter, parseDocument } from "yaml";
import { normalizeText, splitFrontmatter } from "../frontmatter.ts";
import { parseInlines } from "./inline.ts";
import { isMarkerLike, markerIds } from "./syntax.ts";
import type { Block, CvDoc, Inline, ListItem, ParseIssue } from "./types.ts";

type Severity = ParseIssue["severity"];
type Report = (line: number, col: number, severity: Severity, message: string) => void;

/** One source line of a text block: `text` starts at 1-based column `col`. */
type Span = { line: number; col: number; text: string };

/** A paragraph, bullet or heading being collected. */
type TextAcc = { line: number; spans: Span[]; lastRaw: string; lastLine: number };

type TextKind = "section heading" | "entry heading" | "paragraph" | "bullet";

const HEADING = /^(#+)(?:[ \t]+|$)/;
const FENCE = /^(`{3,}|~{3,})/;
const THEMATIC_BREAK = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^[-*+](?:[ \t]+|$)/;
const ORDERED = /^(\d{1,9})[.)](?:[ \t]+|$)/;
const TABLE_DELIMITER = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?$/;
const QUOTE = /^>[ \t]*/;
const SETEXT_UNDERLINE = /^(?:=+|-+)$/;
const ODD_TRAILING_BACKSLASHES = /(?<!\\)\\(?:\\\\)*$/;

type LineStart =
  | { k: "comment"; inner: string; marker: boolean }
  | { k: "comment-open" }
  | { k: "heading"; level: number; prefix: number }
  | { k: "fence"; fence: string }
  | { k: "thematic" }
  | { k: "bullet"; prefix: number }
  | { k: "ordered"; prefix: number; first: boolean }
  | { k: "table"; delimiter: boolean }
  | { k: "quote"; prefix: number }
  | { k: "text" };

/** What a line (leading whitespace removed) would start if no block were open. */
function classify(content: string): LineStart {
  if (content.startsWith("<!--")) {
    const close = content.indexOf("-->", 4);
    if (close === -1) return { k: "comment-open" };
    if (close === content.length - 3) {
      const inner = content.slice(4, close);
      return { k: "comment", inner, marker: isMarkerLike(inner) };
    }
    return { k: "text" };
  }
  const heading = HEADING.exec(content);
  if (heading?.[1]) return { k: "heading", level: heading[1].length, prefix: heading[0].length };
  const fence = FENCE.exec(content);
  if (fence?.[1]) return { k: "fence", fence: fence[1] };
  if (THEMATIC_BREAK.test(content)) return { k: "thematic" };
  const bullet = BULLET.exec(content);
  if (bullet) return { k: "bullet", prefix: bullet[0].length };
  const ordered = ORDERED.exec(content);
  if (ordered) return { k: "ordered", prefix: ordered[0].length, first: ordered[1] === "1" };
  if (content.startsWith("|") || TABLE_DELIMITER.test(content)) {
    return { k: "table", delimiter: TABLE_DELIMITER.test(content) };
  }
  const quote = QUOTE.exec(content);
  if (quote) return { k: "quote", prefix: quote[0].length };
  return { k: "text" };
}

/** Width of the leading whitespace, tabs advancing to the next multiple of four. */
function indentOf(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width++;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Unescaped, complete `<!-- ... -->` comments on one line. */
function findComments(text: string): { start: number; end: number; inner: string }[] {
  const found: { start: number; end: number; inner: string }[] = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    let slashes = 0;
    while (text.charAt(open - 1 - slashes) === "\\") slashes++;
    if (slashes % 2 === 1) {
      from = open + 1;
      continue;
    }
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    found.push({ start: open, end: close + 3, inner: text.slice(open + 4, close) });
    from = close + 3;
  }
  return found;
}

/**
 * Turns the collected lines of one block into inline nodes and evidence ids: strips comments,
 * validates the marker, joins lines with one space and parses inline syntax.
 */
function finalizeText(spans: Span[], kind: TextKind, report: Report) {
  const ev: string[] = [];
  const markers: { line: number; col: number; text: string; atEnd: boolean }[] = [];
  let joined = "";
  /** Where each stretch of `joined` comes from, for mapping inline issues back to the file. */
  const origins: { at: number; line: number; col: number }[] = [];

  spans.forEach((span, index) => {
    const last = index === spans.length - 1;
    const kept: { text: string; col: number }[] = [];
    let from = 0;
    for (const comment of findComments(span.text)) {
      kept.push({ text: span.text.slice(from, comment.start), col: span.col + from });
      from = comment.end;
      const col = span.col + comment.start;
      if (isMarkerLike(comment.inner)) {
        const text = span.text.slice(comment.start, comment.end);
        markers.push({ line: span.line, col, text, atEnd: last && from === span.text.length });
      } else {
        report(span.line, col, "error", "Comments go on their own line, not inside text");
      }
    }
    kept.push({ text: span.text.slice(from), col: span.col + from });

    // Trim the line as a whole: comments may leave whitespace at either end.
    while (kept.length > 0) {
      const first = kept[0];
      if (!first) break;
      const trimmed = first.text.replace(/^\s+/, "");
      if (trimmed === "") {
        kept.shift();
        continue;
      }
      kept[0] = { text: trimmed, col: first.col + first.text.length - trimmed.length };
      break;
    }
    while (kept.length > 0) {
      const lastPiece = kept[kept.length - 1];
      if (!lastPiece) break;
      const trimmed = lastPiece.text.replace(/\s+$/, "");
      if (trimmed === "") {
        kept.pop();
        continue;
      }
      kept[kept.length - 1] = { text: trimmed, col: lastPiece.col };
      break;
    }
    if (kept.length === 0) return;
    if (joined !== "") {
      const previous = origins[origins.length - 1];
      if (previous) origins.push({ at: joined.length, line: previous.line, col: previous.col });
      joined += " ";
    }
    for (const piece of kept) {
      if (piece.text === "") continue;
      origins.push({ at: joined.length, line: span.line, col: piece.col });
      joined += piece.text;
    }
  });

  markers.forEach((marker, index) => {
    const { line, col } = marker;
    if (kind === "section heading") {
      report(line, col, "error", "Section headings take no evidence marker");
      return;
    }
    if (index > 0) {
      report(line, col, "error", `A ${kind} takes one evidence marker; list every id in it`);
    } else if (markers.length === 1 && !marker.atEnd) {
      report(line, col, "error", `The evidence marker must come at the end of the ${kind}`);
    }
    const ids = markerIds(marker.text);
    if (ids === null) {
      report(
        line,
        col,
        "error",
        "Malformed evidence marker; write <!-- ev: ACH-014 --> or <!-- ev: ACH-014, ACH-020 -->",
      );
      return;
    }
    for (const id of ids) {
      if (ev.includes(id)) report(line, col, "warning", `Evidence id ${id} is cited twice`);
      else ev.push(id);
    }
  });

  const inline = parseInlines(joined);
  for (const problem of inline.issues) {
    let origin = origins[0];
    for (const candidate of origins) {
      if (candidate.at <= problem.pos) origin = candidate;
      else break;
    }
    const line = origin?.line ?? spans[0]?.line ?? 1;
    const col = origin ? origin.col + problem.pos - origin.at : 1;
    report(line, col, "error", problem.message);
  }
  return { text: inline.nodes, ev };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrontmatter(
  yaml: string,
  startLine: number,
  report: Report,
): Record<string, unknown> {
  const counter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter: counter, prettyErrors: false, uniqueKeys: true });
  const at = (pos: number | undefined) => {
    const where = counter.linePos(pos ?? 0);
    return { line: where.line + startLine - 1, col: where.col };
  };
  for (const error of doc.errors) {
    const { line, col } = at(error.pos[0]);
    report(line, col, "error", `Frontmatter YAML: ${error.message.split("\n")[0]}`);
  }
  if (doc.errors.length > 0) return {};
  for (const warning of doc.warnings) {
    const { line, col } = at(warning.pos[0]);
    report(line, col, "warning", `Frontmatter YAML: ${warning.message.split("\n")[0]}`);
  }
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (error) {
    report(startLine, 1, "error", `Frontmatter YAML: ${(error as Error).message}`);
    return {};
  }
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) {
    report(startLine, 1, "error", "Frontmatter must be a YAML mapping of keys to values");
    return {};
  }
  return value;
}

function parseBody(body: string, firstLine: number, report: Report): Block[] {
  const blocks: Block[] = [];
  const state = {
    paragraph: null as TextAcc | null,
    list: null as { indent: number; ordered: boolean; items: ListItem[]; item: TextAcc } | null,
    fence: null as { fence: string; spans: Span[] } | null,
    comment: null as { line: number; parts: string[] } | null,
    /** Consecutive lines of one unsupported construct (a table) are reported once. */
    lastRun: null as { kind: string; line: number } | null,
  };

  const reportRun = (kind: string, line: number, col: number, message: string) => {
    const run = state.lastRun;
    if (!run || run.kind !== kind || run.line !== line - 1) report(line, col, "error", message);
    state.lastRun = { kind, line };
  };

  const newText = (line: number, col: number, text: string, raw: string): TextAcc => ({
    line,
    spans: text === "" ? [] : [{ line, col, text }],
    lastRaw: raw,
    lastLine: line,
  });

  const appendLine = (acc: TextAcc, line: number, col: number, text: string, raw: string) => {
    const isMarker = classify(text).k === "comment";
    if (!isMarker) {
      const spaces = / {2,}$/.exec(acc.lastRaw);
      if (spaces) {
        report(
          acc.lastLine,
          spaces.index + 1,
          "error",
          "Hard line breaks are not supported; remove the trailing spaces",
        );
      } else if (ODD_TRAILING_BACKSLASHES.test(acc.lastRaw)) {
        report(
          acc.lastLine,
          acc.lastRaw.length,
          "error",
          "Hard line breaks are not supported; remove the trailing backslash",
        );
      }
    }
    acc.spans.push({ line, col, text });
    acc.lastRaw = raw;
    acc.lastLine = line;
  };

  const closeParagraph = () => {
    const acc = state.paragraph;
    state.paragraph = null;
    if (!acc) return;
    const { text, ev } = finalizeText(acc.spans, "paragraph", report);
    // Only a line made of comments can leave a paragraph empty; that was reported already.
    if (text.length > 0) blocks.push({ t: "paragraph", text, ev, line: acc.line });
  };

  const closeItem = () => {
    const list = state.list;
    if (!list) return;
    const { text, ev } = finalizeText(list.item.spans, "bullet", report);
    if (text.length === 0 && ev.length === 0) report(list.item.line, 1, "warning", "Empty bullet");
    list.items.push({ text, ev, line: list.item.line });
  };

  const closeList = () => {
    const list = state.list;
    if (!list) return;
    closeItem();
    state.list = null;
    blocks.push({ t: "list", items: list.items });
  };

  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  /** A bullet's first line; `rest` is the text after the marker. */
  const startItem = (line: number, col: number, rest: string, raw: string) => {
    if (BULLET.test(rest) || ORDERED.test(rest)) {
      report(line, col, "error", "Nested lists are not supported; use one level of - bullets");
    }
    return newText(line, col, rest, raw);
  };

  const flushFence = () => {
    const fence = state.fence;
    state.fence = null;
    const first = fence?.spans[0];
    if (!fence || !first) return;
    // Best effort: show the code as plain text so nothing disappears from the preview.
    const text: Inline[] = [{ t: "text", v: fence.spans.map((span) => span.text).join(" ") }];
    blocks.push({ t: "paragraph", text, ev: [], line: first.line });
  };

  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = firstLine + index;
    const raw = lines[index] ?? "";
    const text = raw.replace(/[ \t]+$/, "");
    const content = text.replace(/^[ \t]+/, "");
    const col = text.length - content.length + 1;
    const indent = indentOf(text);

    if (state.fence) {
      const fence = state.fence;
      const marker = fence.fence.charAt(0);
      if (content.length >= fence.fence.length && [...content].every((ch) => ch === marker)) {
        flushFence();
      } else if (content !== "") {
        fence.spans.push({ line, col, text: content });
      }
      continue;
    }

    if (state.comment) {
      const comment = state.comment;
      const close = text.indexOf("-->");
      if (close === -1) {
        comment.parts.push(text);
        continue;
      }
      comment.parts.push(text.slice(0, close));
      if (text.slice(close + 3).trim() !== "") {
        report(
          line,
          close + 4,
          "error",
          "Text after the end of a comment; move it to its own line",
        );
      }
      blocks.push({ t: "comment", v: comment.parts.join("\n").trim(), line: comment.line });
      state.comment = null;
      continue;
    }

    if (content === "") {
      closeAll();
      continue;
    }

    const start = classify(content);
    const isMarkerLine = start.k === "comment" && start.marker;
    const opensComment = start.k === "comment" || start.k === "comment-open";

    let afterList = false;
    if (state.list) {
      const list = state.list;
      if (isMarkerLine) {
        appendLine(list.item, line, col, content, raw);
        continue;
      }
      if (indent >= list.indent + 2 && !opensComment) {
        if (start.k === "bullet" || start.k === "ordered") {
          report(line, col, "error", "Nested lists are not supported; use one level of - bullets");
          closeItem();
          list.item = startItem(line, col + start.prefix, content.slice(start.prefix), raw);
        } else {
          appendLine(list.item, line, col, content, raw);
        }
        continue;
      }
      if (start.k === "bullet" || start.k === "ordered") {
        if (start.k === "ordered" && !list.ordered) {
          report(line, col, "error", "Ordered lists are not supported; use - bullets");
          list.ordered = true;
        }
        closeItem();
        list.item = startItem(line, col + start.prefix, content.slice(start.prefix), raw);
        continue;
      }
      closeList();
      afterList = true;
    } else if (state.paragraph) {
      const paragraph = state.paragraph;
      if (isMarkerLine) {
        appendLine(paragraph, line, col, content, raw);
        continue;
      }
      if (indent >= 4) {
        appendLine(paragraph, line, col, content, raw);
        continue;
      }
      if (SETEXT_UNDERLINE.test(content)) {
        report(line, col, "error", "Underlined headings are not supported; use ## or ###");
        closeParagraph();
        continue;
      }
      const interrupts = start.k !== "text" && !(start.k === "ordered" && !start.first);
      if (!interrupts) {
        appendLine(paragraph, line, col, content, raw);
        continue;
      }
      closeParagraph();
    }

    if (indent >= 4 && !opensComment) {
      reportRun("code", line, col, "Indented code is not supported; remove the indentation");
      state.paragraph = newText(line, col, content, raw);
      continue;
    }

    switch (start.k) {
      case "comment":
        if (start.marker) {
          report(
            line,
            col,
            "error",
            "Evidence marker on its own line; put it at the end of the heading, paragraph or bullet it supports",
          );
        }
        blocks.push({ t: "comment", v: start.inner.trim(), line });
        break;
      case "comment-open":
        state.comment = { line, parts: [content.slice(4)] };
        break;
      case "heading": {
        const { level, prefix } = start;
        if (level === 1) {
          report(
            line,
            col,
            "error",
            "# headings are not supported; the name comes from profile/contact.yaml. Use ## for sections",
          );
        } else if (level > 3) {
          report(
            line,
            col,
            "error",
            "#### and deeper headings are not supported; use ### for entries",
          );
        }
        const rest = content.slice(prefix);
        const spans = rest === "" ? [] : [{ line, col: col + prefix, text: rest }];
        if (level <= 2) {
          const { text } = finalizeText(spans, "section heading", report);
          if (text.length === 0) report(line, col, "warning", "Empty section heading");
          blocks.push({ t: "section", text, line });
        } else {
          const { text, ev } = finalizeText(spans, "entry heading", report);
          if (text.length === 0) report(line, col, "warning", "Empty entry heading");
          blocks.push({ t: "entry", text, ev, line });
        }
        break;
      }
      case "fence":
        report(line, col, "error", "Code blocks are not supported");
        state.fence = { fence: start.fence, spans: [] };
        break;
      case "thematic":
        report(
          line,
          col,
          "error",
          "Horizontal rules are not supported; ## headings separate sections",
        );
        break;
      case "bullet":
      case "ordered":
        if (start.k === "ordered") {
          report(line, col, "error", "Ordered lists are not supported; use - bullets");
        }
        state.list = {
          indent,
          ordered: start.k === "ordered",
          items: [],
          item: startItem(line, col + start.prefix, content.slice(start.prefix), raw),
        };
        break;
      case "table":
        reportRun("table", line, col, "Tables are not supported; use bullets");
        if (!start.delimiter) state.paragraph = newText(line, col, content, raw);
        break;
      case "quote":
        reportRun("quote", line, col, "Block quotes are not supported");
        state.paragraph = newText(line, col + start.prefix, content.slice(start.prefix), raw);
        break;
      case "text":
        if (afterList) {
          report(
            line,
            col,
            "warning",
            "Bullet continuation lines are indented two spaces; this line starts a new paragraph",
          );
        }
        state.paragraph = newText(line, col, content, raw);
        break;
    }
  }

  closeAll();
  flushFence();
  if (state.comment) {
    const comment = state.comment;
    report(comment.line, 1, "error", "Comment is never closed; end it with -->");
    blocks.push({ t: "comment", v: comment.parts.join("\n").trim(), line: comment.line });
    state.comment = null;
  }
  return blocks;
}

/** 1-based line on which `offset` falls. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Parses a CV in the dialect of docs/cv-dialect.md. Never throws: problems become line-numbered
 * issues and the AST holds everything that could be read, so the UI can still show it.
 */
export function parseCv(text: string): { doc: CvDoc; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const report: Report = (line, col, severity, message) => {
    issues.push({ line, col, severity, message });
  };
  const doc: CvDoc = { frontmatter: {}, blocks: [] };
  try {
    const normalized = normalizeText(text);
    const split = splitFrontmatter(normalized);
    if (split.yaml !== null) {
      doc.frontmatter = parseFrontmatter(split.yaml, split.yamlStartLine, report);
    }
    let body = split.body;
    if (split.yaml === null && /^---[ \t]*(?:\n|$)/.test(normalized)) {
      report(1, 1, "error", "Frontmatter is not closed; add a --- line after it");
      const newline = normalized.indexOf("\n");
      body = newline === -1 ? "" : normalized.slice(newline + 1);
    }
    const bodyStart = lineAt(normalized, normalized.length - body.length);
    doc.blocks = parseBody(body, bodyStart, report);
  } catch (error) {
    report(1, 1, "error", `Could not read this CV: ${(error as Error).message}`);
  }
  issues.sort((a, b) => a.line - b.line || a.col - b.col);
  return { doc, issues };
}
