# CV Markdown dialect (v1)

Base and tailored CVs are Markdown in a deliberately small dialect: small enough for a hand-written
parser, expressive enough for an ATS-safe CV, and round-trip stable. The parser (M2) lives in
`src/shared/cv`. `serialize(parse(text))` is the canonical form and `parse(serialize(ast))` equals
the AST.

## File

- UTF-8, LF (CRLF accepted on read). Trailing whitespace is ignored.
- Optional YAML frontmatter between `---` lines at the very top.
- The header (name, contact line) is rendered from `profile/contact.yaml` plus `headline` from the
  frontmatter. The body never contains the name.

## Blocks

| Syntax | Meaning |
|---|---|
| `## Experience` | Section heading |
| `### Engineering Manager · Acme Corp · 2021-03 - present` | Entry heading (role, project, degree). Free text; checks use evidence, not position. |
| text lines | Paragraph; consecutive lines join with a space |
| `- text` | Bullet. One level only. Continuation lines are indented two spaces. |
| blank line | Block separator |
| `<!-- anything -->` on its own line | Author comment: kept by the serializer, never rendered |

Rejected with a line-numbered error: `#` headings (the name comes from contact.yaml), `####` and
deeper, nested or ordered lists, tables, code, images, raw HTML and hard line breaks. `*` and `+`
bullets are accepted on read and written as `-`.

## Inline

`**bold**`, `*italic*`, `[text](https://...)` (http, https and mailto only) and backslash escapes
for `\* \[ \] \\ \<`. Everything else is literal text, and HTML is escaped when rendered.

## Evidence markers

An entry heading, paragraph or bullet may end with exactly one marker that cites experience-bank
entries:

```markdown
- Grew the platform team from 4 to 14 engineers in 18 months <!-- ev: ACH-014 -->
- Cut p95 API latency by 40% by moving hot paths to Go <!-- ev: ACH-020, ACH-021 -->
```

Grammar: `<!--` ws `ev:` ws `ID` ( ws? `,` ws? `ID` )* ws `-->` at the end of the block's last line,
where `ID` matches `[A-Z]{2,5}-[0-9]{3,}` (ROLE-003, ACH-014, SKL-021, EDU-001). The parser attaches
the ids to the block and the renderer drops the marker, so it never reaches HTML or PDF. Section
headings (`##`) take no marker.

Rules:

- **Base CVs** (`profile/bases/*.md`): markers are recommended; a missing one is a warning.
- **Tailored CVs** (`jobs/*/cv.md`): every entry heading, paragraph and bullet carries at least one
  id, and every id exists in the bank. This is blocking (guard G1).

Markers power evidence chips in the review UI, the diff against the base, the deterministic checks
(numbers, company names, dates and titles must match the cited entries) and the faithfulness
verifier.

## Frontmatter

```yaml
# profile/bases/em.md
id: em
label: Engineering Manager
track: management              # management | ic
target_titles: [Engineering Manager, Senior Engineering Manager]
headline: Engineering Manager, Platform and Developer Experience
emphasis: [people leadership, delivery, platform]
theme: classic
```

```yaml
# jobs/<id>/cv.md (tailored)
job: 2026-11-16_acme_engineering-manager-platform
base: em
base_sha256: <hash of the base file used; cv.base.md is the copy>
headline: Engineering Manager, Platform
generated_at: 2026-11-16T11:02:00+01:00
engine: { id: anthropic-api, model: claude-opus-5-5 }
theme: classic                 # copied from the base
notes: Led with platform reliability; German is not in the bank.
```

The deterministic checks and the verifier work per claim (`src/shared/cv/claims.ts`): entry
headings, paragraphs and bullets in document order, as plain text without formatting. Write entry
headings so each part stands alone between separators, for example
`### Engineering Manager, Acme Robotics | 2021-03 - present`: the title check reads
"Senior Engineering Manager" as a different title from "Engineering Manager".

## AST

```ts
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
export type ParseIssue = { line: number; col: number; severity: "error" | "warning"; message: string };
```

Line numbers let the review UI map verifier results and evidence chips back to source lines.
