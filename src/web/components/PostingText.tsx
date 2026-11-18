import type { ComponentChildren } from "preact";

/**
 * Renders posting text as saved in posting.md: "## " headings, "- " bullets, paragraphs.
 * Lenient on purpose (postings are third-party text) and never interprets HTML.
 */
export function PostingText(props: { text: string }) {
  const blocks = props.text
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: ComponentChildren[] = [];
  blocks.forEach((block, i) => {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.every((l) => /^\s*[-*\u2022]\s+/.test(l))) {
      out.push(
        <ul key={i}>
          {lines.map((l, j) => (
            <li key={j}>{l.replace(/^\s*[-*\u2022]\s+/, "")}</li>
          ))}
        </ul>,
      );
    } else if (lines.length === 1 && /^#{1,6}\s+/.test(block)) {
      out.push(<h3 key={i}>{block.replace(/^#{1,6}\s+/, "")}</h3>);
    } else {
      out.push(<p key={i}>{block}</p>);
    }
  });
  return <div class="posting-text">{out}</div>;
}
