import { ESCAPABLE, isAllowedHref } from "./syntax.ts";
import type { Inline } from "./types.ts";

/** A problem at `pos`, an offset into the string given to parseInlines. */
export type InlineIssue = { pos: number; message: string };

type Closer = "*" | "**";
type Run = { nodes: Inline[]; next: number; issues: InlineIssue[] };

const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/;
const EMAIL_AUTOLINK = /^<[A-Za-z0-9][^\s<>@]*@[^\s<>@]+>/;
const HTML_TAG = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/;
const HTML_OTHER = /^<[!?][^<>]*>/;

const isSpace = (ch: string) => ch === "" || /\s/.test(ch);
const isEscapable = (ch: string) => ch !== "" && ESCAPABLE.includes(ch);

/** Collects inline nodes, merging adjacent text. */
class Builder {
  nodes: Inline[] = [];
  #text = "";

  text(v: string): void {
    this.#text += v;
  }

  node(node: Inline): void {
    this.#flush();
    this.nodes.push(node);
  }

  all(nodes: readonly Inline[]): void {
    for (const node of nodes) {
      if (node.t === "text") this.text(node.v);
      else this.node(node);
    }
  }

  done(): Inline[] {
    this.#flush();
    return this.nodes;
  }

  #flush(): void {
    if (this.#text !== "") this.nodes.push({ t: "text", v: this.#text });
    this.#text = "";
  }
}

/**
 * Parses `**strong**`, `*em*`, `[text](url)` and backslash escapes. Anything that does not match
 * is literal text. Rules, kept small on purpose:
 * - an opener must be followed and a closer preceded by a non-space character, and the content
 *   must hold something besides asterisks;
 * - the leftmost opener wins and takes the nearest valid closer; `**` is tried before `*`;
 * - link text may contain strong and em but no links;
 * - images, raw HTML, autolinks and links to other schemes are reported and kept as text.
 */
export function parseInlines(s: string): { nodes: Inline[]; issues: InlineIssue[] } {
  // Failed attempts are retried from many openers; memoising keeps the worst case quadratic.
  const memo = new Map<string, Run | null>();
  /** lastPlain[i]: index of the last character before i that is not `*`, or -1. */
  const lastPlain: number[] = [];
  for (let i = 0, last = -1; i <= s.length; i++) {
    lastPlain.push(last);
    if (s.charAt(i) !== "*") last = i;
  }
  /**
   * lastCloser[closer][e]: the last index q that could close `closer` in text ending at e (the
   * delimiter fits before e and follows a non-space), or -1. Lets hopeless attempts fail fast.
   */
  const lastCloser: Record<Closer, number[]> = { "*": [], "**": [] };
  for (const closer of ["*", "**"] as const) {
    const table = lastCloser[closer];
    for (let e = 0, last = -1; e <= s.length; e++) {
      const q = e - closer.length;
      if (q >= 1 && s.startsWith(closer, q) && !isSpace(s.charAt(q - 1))) last = q;
      table.push(last);
    }
  }

  const findLink = (open: number, end: number) => {
    let depth = 0;
    let close = -1;
    for (let j = open; j < end; j++) {
      const ch = s.charAt(j);
      if (ch === "\\" && j + 1 < end && isEscapable(s.charAt(j + 1))) j++;
      else if (ch === "[") depth++;
      else if (ch === "]" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close <= open + 1 || s.charAt(close + 1) !== "(") return null;
    let parens = 0;
    for (let k = close + 2; k < end; k++) {
      const ch = s.charAt(k);
      if (/[\s<>]/.test(ch)) return null;
      if (ch === "(") parens++;
      else if (ch === ")") {
        if (parens > 0) parens--;
        else if (k === close + 2) return null;
        else
          return { textStart: open + 1, textEnd: close, href: s.slice(close + 2, k), next: k + 1 };
      }
    }
    return null;
  };

  const run = (start: number, end: number, closer: Closer | null, inLink: boolean): Run | null => {
    const key = `${start}:${end}:${closer}:${inLink}`;
    if (closer !== null) {
      if (memo.has(key)) return memo.get(key) ?? null;
      // The latest candidate closer is the most likely to qualify; if it cannot, none can.
      const q = lastCloser[closer][end] ?? -1;
      if (q <= start || (lastPlain[q] ?? -1) < start) return null;
    }

    const out = new Builder();
    const issues: InlineIssue[] = [];
    let result: Run | null = null;
    let i = start;
    while (i < end) {
      const ch = s.charAt(i);
      if (closer !== null && i > start && s.startsWith(closer, i) && i + closer.length <= end) {
        // A closer follows a non-space, and asterisks alone (`****`) are not emphasis.
        if (!isSpace(s.charAt(i - 1)) && (lastPlain[i] ?? -1) >= start) {
          result = { nodes: out.done(), next: i + closer.length, issues };
          break;
        }
      }
      if (ch === "\\" && i + 1 < end && isEscapable(s.charAt(i + 1))) {
        out.text(s.charAt(i + 1));
        i += 2;
        continue;
      }
      if (ch === "*") {
        if (s.charAt(i + 1) === "*" && i + 2 < end && !isSpace(s.charAt(i + 2))) {
          const inner = run(i + 2, end, "**", inLink);
          if (inner && inner.nodes.length > 0) {
            out.node({ t: "strong", c: inner.nodes });
            issues.push(...inner.issues);
            i = inner.next;
            continue;
          }
        }
        if (i + 1 < end && !isSpace(s.charAt(i + 1))) {
          const inner = run(i + 1, end, "*", inLink);
          if (inner && inner.nodes.length > 0) {
            out.node({ t: "em", c: inner.nodes });
            issues.push(...inner.issues);
            i = inner.next;
            continue;
          }
        }
        out.text("*");
        i++;
        continue;
      }
      const image = ch === "!" && s.charAt(i + 1) === "[";
      if ((ch === "[" || image) && !inLink) {
        const link = findLink(image ? i + 1 : i, end);
        if (link) {
          const text = run(link.textStart, link.textEnd, null, true);
          const children = text?.nodes ?? [];
          issues.push(...(text?.issues ?? []));
          if (!image && isAllowedHref(link.href)) {
            out.node({ t: "link", href: link.href, c: children });
          } else {
            issues.push({
              pos: i,
              message: image
                ? "Images are not supported"
                : `Links must use http, https or mailto: ${link.href}`,
            });
            out.text(image ? "![" : "[");
            out.all(children);
            out.text(`](${link.href})`);
          }
          i = link.next;
          continue;
        }
      }
      if (ch === "<") {
        const rest = s.slice(i, end);
        if (rest.startsWith("<!--")) {
          issues.push({ pos: i, message: "Unclosed comment; comments go on their own line" });
          out.text("<!--");
          i += 4;
          continue;
        }
        const autolink = AUTOLINK.exec(rest) ?? EMAIL_AUTOLINK.exec(rest);
        const html = autolink ? null : (HTML_TAG.exec(rest) ?? HTML_OTHER.exec(rest));
        const match = autolink ?? html;
        if (match) {
          issues.push({
            pos: i,
            message: autolink
              ? "Autolinks are not supported; write [text](url)"
              : "Raw HTML is not supported",
          });
          out.text(match[0]);
          i += match[0].length;
          continue;
        }
      }
      out.text(ch);
      i++;
    }
    if (closer === null) result = { nodes: out.done(), next: end, issues };
    else memo.set(key, result);
    return result;
  };

  const top = run(0, s.length, null, false);
  return { nodes: top?.nodes ?? [], issues: top?.issues ?? [] };
}
