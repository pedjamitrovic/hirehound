# Hirehound design proposal (pre-M0)

Status: approved 2026-11-16 (decisions in section 7). During M0 this is split into `CLAUDE.md`, `docs/data-contract.md`, `docs/cv-dialect.md` and `docs/ux.md`.

Contents:
1. Repo structure
2. Zod schemas for workspace files
3. CV Markdown dialect
4. AI engine adapter interface
5. Wireframes (Today, Pipeline, Job dossier, CV review)
6. M0 + M1 plan
7. Decisions I need from you

---

## 1. Repo structure

Single package, npm, ESM, Node 24+ with native type stripping. Tests are colocated (`*.test.ts`) so they move with the code.

```
hirehound/
  .github/workflows/ci.yml       # windows-latest + ubuntu-latest  x  Node 24, 26
  .gitattributes                 # * text=auto eol=lf  (repo is LF everywhere, incl. Windows)
  .gitignore                     # node_modules, dist, .env*, *.pdf, workspace/, .hirehound/
  .editorconfig
  biome.json
  tsconfig.base.json             # strict, erasableSyntaxOnly, verbatimModuleSyntax, allowImportingTsExtensions, noEmit
  tsconfig.server.json           # src/server + src/shared, lib: es2024, types: node
  tsconfig.web.json              # src/web + src/shared, lib: dom, jsx: react-jsx, jsxImportSource: preact
  vite.config.ts                 # root: src/web, outDir: dist/web, JSX via built-in transform (no preset)
  package.json                   # "type": "module", engines.node >= 24, bin: hirehound
  CLAUDE.md  README.md  LICENSE
  docs/
    PRD.md
    data-contract.md             # every workspace file, its schema, who writes it
    cv-dialect.md
  bin/
    hirehound.ts                 # CLI entry: `hirehound [serve] | init [path]`
  src/
    shared/                      # isomorphic, imported by server AND web; no node:* imports here
      schemas/
        common.ts                # ids, dates, money, hashes
        preferences.ts  contact.ts  answers.ts
        posting.ts  status.ts  evaluation.ts
        api.ts                   # request/response DTOs for the HTTP API
        index.ts
      states.ts                  # state machine: graph, guards, labels
      score.ts                   # deterministic fit score from the requirement matrix
      slug.ts                    # slugify + Windows-safe names
      cv/                        # dialect parser + serializer (pure; used by server and review UI)
        parse.ts  serialize.ts  types.ts
    server/
      main.ts                    # start: resolve workspace, build index, start http, open browser
      config.ts                  # workspace resolution (flag > env > config.yaml > OS default)
      http/
        router.ts                # ~100 lines: method + path pattern -> handler, params, JSON body
        sse.ts                   # SSE hub: broadcast index changes + task progress
        static.ts                # serve dist/web; in --dev, mount Vite in middleware mode
        guard.ts                 # Host/Origin checks (DNS-rebinding + CSRF protection)
      workspace/
        init.ts                  # scaffold a new workspace with commented example files
        fsx.ts                   # atomic write (tmp + rename, Windows EPERM retry), LF normalisation
        frontmatter.ts           # split/join `---` YAML frontmatter
        index.ts                 # in-memory index: Map<JobId, JobSummary> + diagnostics
        watcher.ts               # fs.watch recursive, debounced per job folder, polling fallback
      jobs/
        service.ts               # create job, transition, add note/contact
        snapshot.ts              # fetch URL -> posting.html + posting.md
        extract.ts               # JSON-LD JobPosting / OpenGraph metadata extraction
        html-text.ts             # small HTML -> readable text converter
      routes/                    # one file per resource, wires service -> router
      ai/                        # M2: engine adapter, tasks, prompts/
      pdf/                       # M2: render via playwright-core + installed Chrome/Edge
    web/
      index.html  main.tsx  app.tsx
      router.ts                  # history-API router, ~40 lines
      api.ts                     # typed fetch client using shared/schemas/api.ts
      state/                     # signals: jobs index, selection, filters, SSE connection
      hotkeys.ts                 # tiny keymap: single keys + "g t" style sequences
      components/                # Button, Badge, ScoreChip, Kbd, Table, Tabs, Dialog, Menu, Toast, Empty
      screens/                   # Today, Pipeline (Board, Table), Job (dossier tabs), Settings
      styles/
        tokens.css               # colors, spacing, type scale, radii as custom properties; dark mode
        base.css  components.css
  test/
    fixtures/                    # sample workspace + saved job pages (Greenhouse, Lever, Ashby HTML)
    e2e/                         # later: playwright-core smoke tests
```

Scripts: `dev` (server with `node --watch` + Vite middleware on one port), `build` (Vite), `start`, `test` (`node --test`), `typecheck` (both tsconfigs), `lint`, `format`, `check` (lint + typecheck + test, what CI runs).

Notes:
- Imports use explicit `.ts` extensions (required by native type stripping) and `import type` for types.
- Native type stripping does not run inside `node_modules`, so `npx hirehound` (M7) will need a publish-time step that emits JS with `tsc` (`rewriteRelativeImportExtensions`). Dev and CI run the `.ts` sources directly.

---

## 2. Zod schemas (Zod 4)

General rules:
- Every YAML file carries `version: 1` so we can migrate later.
- Workspace files are hand-editable. Parsing strips unknown keys but reports them as warnings, so a typo like `treshold:` is visible in the UI instead of being silently ignored. A file that fails validation never crashes the server: the index stores a diagnostic and the UI shows the job with an "invalid file" badge and the exact error.
- LLM outputs are validated strictly (no unknown keys) and are never written to disk unless valid.
- Timestamps are ISO 8601 with the local offset (`2026-11-16T10:42:00+01:00`); dates are `YYYY-MM-DD`.
- When the app edits a user-owned YAML file (e.g. preferences from a form), it uses the `yaml` Document API so comments and key order survive.

### common.ts

```ts
import { z } from "zod";

export const Version = z.literal(1).default(1);
export const IsoDate = z.iso.date();                          // 2026-11-16
export const IsoDateTime = z.iso.datetime({ offset: true });  // 2026-11-16T10:42:00+01:00
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);   // ISO 4217
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);    // ISO 3166-1 alpha-2
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// Experience-bank entry id: ROLE-003, ACH-014, SKL-021, EDU-001, ...
export const BankId = z.string().regex(/^[A-Z]{2,5}-\d{3,}$/);
// Base profile id = file stem in profile/bases/ (em.md -> "em")
export const BaseId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
// Job id = folder name: <found date>_<company slug>_<role slug>[-n]
export const JobId = z.string().regex(/^\d{4}-\d{2}-\d{2}_[a-z0-9-]{1,30}_[a-z0-9-]{1,48}$/);

export const Period = z.enum(["year", "month", "day", "hour"]);
export const SalaryRange = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    currency: CurrencyCode,
    period: Period.default("year"),
    raw: z.string().optional(), // as written in the posting, e.g. "EUR 90-110k + equity"
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, "min must be <= max");
```

### preferences.yaml

```ts
export const Seniority = z.enum([
  "mid", "senior", "staff", "principal",
  "manager", "senior-manager", "director", "vp",
]);
export const CompanySize = z.enum(["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"]);

export const Preferences = z.object({
  version: Version,
  roles: z.object({
    seniority: z.array(Seniority).default([]),
    // Target titles live on each base profile; these are extra keywords for discovery.
    include_title_keywords: z.array(z.string()).default([]),
    exclude_title_keywords: z.array(z.string()).default([]),  // hard filter, e.g. "intern", "sales"
  }),
  location: z.object({
    based_in: z.object({ country: CountryCode, city: z.string().optional() }),
    remote: z.enum(["remote-only", "hybrid-ok", "onsite-ok"]).default("hybrid-ok"),
    acceptable_locations: z.array(z.string()).default([]),   // "Remote (EU)", "Berlin", "Amsterdam"
    timezone: z.string(),                                     // IANA, e.g. "Europe/Belgrade"
    acceptable_utc_offsets: z.tuple([z.number(), z.number()]).optional(), // [-1, 3]
    work_authorization: z.array(z.string()).default([]),     // where you may work without sponsorship: ["RS", "EU"]
    needs_sponsorship_elsewhere: z.boolean().default(true),
    open_to_relocation: z.boolean().default(false),
  }),
  compensation: z.object({
    floor: SalaryRange.optional(),    // below this -> evaluation flags it
    target: SalaryRange.optional(),
  }).default({}),
  company: z.object({
    sizes: z.array(CompanySize).default([]),                  // empty = any
    include_industries: z.array(z.string()).default([]),
    exclude_industries: z.array(z.string()).default([]),     // hard filter
    exclude_companies: z.array(z.string()).default([]),      // hard filter
  }).default({}),
  deal_breakers: z.array(z.string()).default([]),             // free text, judged by the evaluator
  scoring: z.object({
    threshold: z.number().int().min(0).max(100).default(70),  // guardrail warning below this
  }).default({}),
  cover_letter: z.object({
    policy: z.enum(["always", "when-requested", "never"]).default("when-requested"),
  }).default({}),
  apply: z.object({ mode: z.enum(["manual", "assisted"]).default("manual") }).default({}),
  cv: z.object({ max_pages: z.number().int().min(1).max(4).default(2) }).default({}),
});
```

### contact.yaml

The CV header (name, contact line) is rendered from this file, never from the CV Markdown, so there is one source of truth.

```ts
export const Contact = z.object({
  version: Version,
  name: z.string().min(1),
  email: z.email(),
  phone: z.string().optional(),
  location: z.string().optional(),               // "Belgrade, Serbia"
  links: z.array(z.object({
    label: z.string(),                           // "LinkedIn", "GitHub", "Website"
    url: z.url(),
  })).default([]),
});
```

### answers.yaml

```ts
export const Answer = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),          // stable key: "notice-period"
  question: z.string(),                          // canonical phrasing
  aliases: z.array(z.string()).default([]),      // other phrasings seen on forms, used for matching
  answer: z.string(),
  kind: z.enum(["text", "yes-no", "number", "choice", "url", "date"]).default("text"),
  tags: z.array(z.string()).default([]),         // "work-authorization", "salary", "eeo"
  sensitive: z.boolean().default(false),         // EEO, disability, etc: never filled without asking
  updated_at: IsoDate.optional(),
});

export const AnswersFile = z.object({
  version: Version,
  answers: z.array(Answer).default([]),
}).refine((f) => new Set(f.answers.map((a) => a.id)).size === f.answers.length, "answer ids must be unique");
```

### posting.md frontmatter

Body is the posting as readable text (headings and bullets kept). `posting.html` is the raw HTML snapshot when we fetched a URL.

```ts
export const PostingSource = z.enum([
  "manual-url", "manual-text",                  // M1
  "greenhouse", "lever", "ashby", "workable", "smartrecruiters",
  "linkedin-email", "browser",                  // M5
]);

export const PostingFrontmatter = z.object({
  version: Version,
  company: z.string().min(1),
  title: z.string().min(1),
  url: z.url().optional(),                       // absent for pasted text
  source: PostingSource,
  source_ref: z.string().optional(),             // ATS job id; dedupe key in M5
  location: z.string().optional(),
  workplace: z.enum(["remote", "hybrid", "onsite", "unknown"]).default("unknown"),
  employment_type: z.enum(["full-time", "part-time", "contract", "internship", "unknown"]).default("unknown"),
  salary: SalaryRange.optional(),                // only if stated in the posting
  posted_at: IsoDate.optional(),
  fetched_at: IsoDateTime,
  text_sha256: Sha256,                           // hash of normalised body text: change + repost detection
});
```

### status.yaml

```ts
export const JOB_STATES = [
  "found", "evaluated", "tailoring", "ready", "approved",
  "applied", "screening", "interviewing", "offer", "accepted",
  "rejected", "withdrawn", "skipped", "expired",
] as const;
export const JobState = z.enum(JOB_STATES);

export const StatusEvent = z.object({
  at: IsoDateTime,
  from: JobState.nullable(),                     // null for the creation event
  to: JobState,
  by: z.enum(["user", "system", "ai"]),
  reason: z.string().optional(),                 // required for skip/withdraw/guardrail override
});

export const Note = z.object({ at: IsoDateTime, text: z.string().min(1) });

export const Person = z.object({
  name: z.string().min(1),
  role: z.enum(["recruiter", "hiring-manager", "interviewer", "referral", "other"]),
  email: z.email().optional(),
  phone: z.string().optional(),
  linkedin: z.url().optional(),
  notes: z.string().optional(),
});

export const Approval = z.object({                // written in M3
  at: IsoDateTime,
  cv_sha256: Sha256,
  cover_letter_sha256: Sha256.optional(),
  base: BaseId,
  override_reason: z.string().optional(),        // set when approved below the score threshold
});

export const Application = z.object({             // written in M4 (or "external" from M1)
  at: IsoDateTime,
  method: z.enum(["manual", "assisted", "external"]), // external = applied outside Hirehound, no approval record
  cv_sha256: Sha256.optional(),                  // must equal approval.cv_sha256 unless external
});

export const StatusFile = z.object({
  version: Version,
  state: JobState,                               // authoritative; must equal history.at(-1).to
  base: BaseId.optional(),
  history: z.array(StatusEvent).min(1),          // append-only
  notes: z.array(Note).default([]),
  contacts: z.array(Person).default([]),
  tags: z.array(z.string()).default([]),
  approval: Approval.optional(),
  application: Application.optional(),
});
```

If someone hand-edits `state` without adding history, the file still loads; the index reports a warning and the next transition records `from` as the edited state.

### State machine (`src/shared/states.ts`)

```
found        -> evaluated, skipped, expired
evaluated    -> tailoring, found (re-evaluate), skipped, expired
tailoring    -> ready [G1], evaluated, skipped, expired
ready        -> approved [G2], tailoring (request changes), skipped, expired
approved     -> applied [G3], ready (revoke approval), skipped, expired
applied      -> screening, interviewing, offer, rejected, withdrawn
screening    -> interviewing, offer, rejected, withdrawn
interviewing -> offer, rejected, withdrawn
offer        -> accepted, rejected (rescinded), withdrawn (declined)
accepted     -> (terminal)
skipped, expired, rejected, withdrawn -> reopen: back to the last non-terminal state in history
any pre-apply state -> applied with method "external" (reason required; no CV/approval record)

[G1] tailored CV passes deterministic checks and verifier has 0 unsupported claims    (M3)
[G2] cv.pdf exists; approval stores its SHA-256                                       (M3)
[G3] sha256(cv.pdf) == approval.cv_sha256, i.e. the PDF did not change since approval  (M4)
```

Guards are code in one place, used by both the API (enforced) and the UI (to disable invalid moves with a tooltip that says why). Until M3 exists, G1/G2 always fail with "needs a verified CV (M3)".

### Evaluation output (LLM contract) and `evaluation.md`

```ts
export const Requirement = z.object({
  id: z.string(),                                         // "R1"
  text: z.string(),
  weight: z.enum(["must", "strong", "nice"]),
  source: z.enum(["jd-wording", "jd-structure", "estimate"]), // how we know it is a requirement
  quote: z.string().optional(),                           // verbatim JD snippet when source = jd-wording
  match: z.enum(["met", "partial", "gap"]),
  evidence: z.array(BankId),                              // must be empty iff match = gap
  note: z.string().optional(),
});

export const EvaluationOutput = z.object({
  summary: z.object({                                     // A
    text: z.string(),
    hidden_signals: z.array(z.string()),                  // "EM title, ~50% hands-on"
  }),
  fit: z.object({                                         // B
    requirements: z.array(Requirement).min(1),
    rationale: z.string(),
  }),
  level: z.object({                                       // C
    base: BaseId,
    rationale: z.string(),
  }),
  compensation: z.object({                                // D
    basis: z.enum(["stated", "estimated", "unknown"]),
    range: SalaryRange.nullable(),
    note: z.string(),
  }),
  work_authorization: z.object({                          // E
    status: z.enum(["compatible", "needs-sponsorship", "incompatible", "unclear"]),
    location_fit: z.enum(["fits", "partial", "no-fit", "unclear"]),
    note: z.string(),
  }),
  legitimacy: z.object({                                  // F
    live: z.enum(["live", "closed", "unknown"]),
    repost: z.enum(["no", "likely", "unknown"]),
    ghost_signals: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
  }),
  recommendation: z.object({                              // G
    verdict: z.enum(["apply", "stretch", "skip"]),
    reason: z.string(),                                   // one line
  }),
});
```

The **score is computed by code** (`src/shared/score.ts`), not by the model, so it is deterministic and testable:

- weight: must = 3, strong = 2, nice = 1; match: met = 1, partial = 0.5, gap = 0
- `raw = round(100 * sum(w * m) / sum(w))`
- estimate cap: compute the same score using only `jd-wording` + `jd-structure` requirements; if that is below the top band (85), the final score is capped at 84
- must-have gap cap: any `must` with `gap` caps the score at 69
- bands: 85-100 strong, 70-84 good, 50-69 stretch, 0-49 weak

After validation, deterministic post-checks run: every cited `BankId` exists in the bank, `level.base` exists, `evidence` is empty iff `gap`. Failures trigger one repair retry with the errors fed back, then fail visibly.

`evaluation.md` = YAML frontmatter with the full `EvaluationOutput` plus `{ version, score, band, engine: { id, model }, created_at, posting_sha256, bank_sha256 }`, and a Markdown body rendered from it (blocks A-G) for humans and Claude Code. The frontmatter is authoritative; `posting_sha256`/`bank_sha256` let the UI mark an evaluation stale when the posting or bank changes.

---

## 3. CV Markdown dialect (v1)

Goal: small enough to parse with a ~300-line hand-written parser, expressive enough for an ATS-safe CV, and round-trip stable (`serialize(parse(x))` is canonical; `parse(serialize(ast))` deep-equals the AST).

### File

- UTF-8, LF (CRLF accepted on read, written as LF). Trailing whitespace is ignored.
- Optional YAML frontmatter between `---` lines at the very top.
- The header (name, contact line) is rendered from `contact.yaml` plus `headline` from frontmatter. The body does not contain the name.

### Blocks

| Syntax | Meaning |
|---|---|
| `## Experience` | Section heading |
| `### Engineering Manager · Acme Corp · 2021-03 - present` | Entry heading (role, project, degree). Free text; deterministic checks use evidence, not position. |
| text lines | Paragraph; consecutive lines join with a space |
| `- text` | Bullet. One level only. Continuation lines indented 2 spaces. |
| blank line | Block separator |
| `<!-- anything -->` on its own line | Author comment; preserved by the serializer, never rendered |

Not supported, rejected with a line-numbered error: `#` (h1, the name comes from contact.yaml), `####` and deeper, nested lists, ordered lists, tables, code, images, raw HTML, hard line breaks. `*`/`+` bullets are accepted on read and normalised to `-`.

### Inline

`**bold**`, `*italic*`, `[text](https://...)` (http, https, mailto only), backslash escapes for `\* \[ \] \\ \<`. Everything else is literal text (HTML is escaped on render).

### Evidence markers

A block (entry heading, paragraph, or bullet) may end with exactly one marker:

```
- Grew the platform team from 4 to 14 engineers in 18 months <!-- ev: ACH-014 -->
- Cut p95 API latency by 40% by moving hot paths to Go <!-- ev: ACH-020, ACH-021 -->
```

Grammar: `<!--` ws `ev:` ws `BankId` (ws? `,` ws? `BankId`)* ws `-->`, at the end of the block's last line. The parser attaches the IDs to the block (`ev: string[]`) and the renderer drops them, so they never reach HTML or PDF. Section headings (`##`) take no marker.

Rules by file:
- Base CVs (`profile/bases/*.md`): markers recommended; missing ones are warnings.
- Tailored CVs (`jobs/*/cv.md`): every entry heading, paragraph and bullet must carry at least one ID, and every ID must exist in the bank. Blocking (part of G1).

### Frontmatter

```yaml
# profile/bases/em.md
id: em
label: Engineering Manager
track: management              # management | ic
target_titles: [Engineering Manager, Senior Engineering Manager]
headline: Engineering Manager, Platform and Developer Experience
emphasis: [people leadership, delivery, platform]
theme: classic

# jobs/<id>/cv.md (tailored)
job: 2026-11-16_acme_engineering-manager-platform
base: em
base_sha256: <hash of the base file used>
headline: Engineering Manager, Platform
generated_at: 2026-11-16T11:02:00+01:00
engine: { id: anthropic-api, model: claude-opus-5-5 }
```

### AST (`src/shared/cv/types.ts`)

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

Line numbers let the review UI map verifier results and evidence chips back to source lines, and make inline edit simple.

---

## 4. AI engine adapter

One interface for single structured calls. Agentic flows (assisted apply, browsing discovery) are out of scope for this interface.

```ts
// src/server/ai/engine.ts
import type { z } from "zod";

export type EngineId = "anthropic-api" | "claude-code";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Attachment =
  | { kind: "text"; name: string; text: string }
  | { kind: "pdf"; name: string; data: Uint8Array };   // onboarding imports

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;          // reported by claude-code; estimated from a price table for the API
};

export type AiProgress =
  | { type: "started"; model: string }
  | { type: "tokens"; outputTokens: number }          // from the stream, drives the progress UI
  | { type: "retry"; attempt: number; reason: string };

export type AiRequest<T> = {
  task: string;              // "evaluate" | "tailor" | "verify" | ... (logging + usage attribution)
  system: string;            // rendered prompt (workspace override or built-in default)
  input: string;             // rendered user content
  attachments?: Attachment[];
  schema: z.ZodType<T>;      // output contract; adapter derives JSON Schema, then validates with Zod
  model?: string;            // default from settings
  effort?: Effort;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onProgress?: (p: AiProgress) => void;
};

export type AiResult<T> = {
  output: T;                 // already Zod-validated
  usage: Usage;
  engine: EngineId;
  model: string;             // model that actually served the request
  durationMs: number;
};

export type EngineHealth =
  | { ok: true; detail: string }                       // "API key from env" / "claude 2.x, logged in"
  | { ok: false; reason: "missing-key" | "not-installed" | "not-logged-in" | "error"; detail: string };

export interface AiEngine {
  readonly id: EngineId;
  health(): Promise<EngineHealth>;
  run<T>(req: AiRequest<T>): Promise<AiResult<T>>;
}

export type AiErrorCode =
  | "auth" | "rate-limit" | "overloaded" | "refusal" | "max-tokens"
  | "invalid-output" | "network" | "aborted" | "unavailable";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  constructor(code: AiErrorCode, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}
```

**Task layer** on top (one file per task):

```ts
export type TaskDef<I, O> = {
  name: string;
  prompt: string;                          // file name in prompts/; workspace prompts/ overrides built-in
  schema: z.ZodType<O>;
  effort: Effort;
  render(input: I): { system: string; input: string; attachments?: Attachment[] };
  postCheck?(output: O, input: I): string[]; // deterministic checks; non-empty -> one repair retry
};

runTask(engine, def, input, { jobId?, signal, onProgress }): Promise<AiResult<O>>
// renders prompt -> engine.run -> postCheck -> (repair retry) -> appends usage to jobs/<id>/ai-log.jsonl
```

**`anthropic-api` engine** (default): `fetch` to `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version`, streaming SSE (progress + no HTTP timeouts on long outputs), `output_config: { format: { type: "json_schema", schema }, effort }`. JSON Schema comes from `z.toJSONSchema()` with unsupported keywords (min/max lengths, numeric bounds) stripped and `additionalProperties: false` added; Zod then enforces the full schema on the result. PDFs go as `document` blocks (base64). Handles `stop_reason` `refusal` / `max_tokens` explicitly. Default model `claude-opus-5-5`, configurable per task in Settings. Exact request fields get checked against the live API docs when implemented in M2.

**`claude-code` engine**: spawns `claude -p --output-format json --json-schema <schema> --system-prompt-file <tmp> --tools "" --no-session-persistence --model <m>`, prompt on stdin, parses the result JSON (structured output, usage, cost). Reuses the user's existing Claude Code login. PDF attachments are written to a temp dir and exposed read-only via `--add-dir` + the Read tool. Windows needs care here: `claude` may be a `.exe` or a `.cmd` shim, and Node refuses to spawn `.cmd` without a shell, so the engine resolves the executable explicitly.

Both engines are tested against a recorded-response fake (no network in CI).

---

## 5. Wireframes (low fidelity)

App shell on every screen: left nav, top bar with search (`/`), `+ Add job` (`N`), and a live task indicator (SSE). `?` opens the shortcut sheet. Global keys: `g t` Today, `g p` Pipeline, `g s` Settings.

### Today

```
+----------------+--------------------------------------------------------------------------+
| HIREHOUND      | Today, Mon 16 Nov                         [/ Search jobs]  [+ Add job  N]  |
|                +--------------------------------------------------------------------------+
| > Today     3  | NEEDS YOUR REVIEW (3)                                      Review all  R  |
|   Pipeline     | +----------------------------------------------------------------------+ |
|   Profile      | |  87  Acme           Engineering Manager, Platform   EM    ready  2h  | |
|   Sources      | |  74  Globex         Staff Engineer                  SSE   ready  1d  | |
|   Insights     | |  58! Initech        Engineering Lead  (below 70)    EM    ready  1d  | |
|                | +----------------------------------------------------------------------+ |
|                | FOLLOW-UPS DUE (2)                  | UPCOMING INTERVIEWS (1)             |
|                |  Umbrella   applied 8d ago  [Draft] |  Thu 19 Nov 14:00  Acme  panel      |
|                |  Hooli      applied 12d ago [Draft] |                                     |
|                +-------------------------------------+-------------------------------------+
|                | NEW FROM SCANS: 12 found, 4 above threshold, 3 filtered    Triage  T    |
| -------------- | TO EVALUATE (4)                                                          |
|   Settings     |  Vandelay   Senior SWE, Payments      found 3h ago   [Evaluate]          |
| ws: ~/Docu..   | RUNNING: evaluating Globex... 1.2k tokens  |  tailoring Acme... 3/5 steps  |
+----------------+--------------------------------------------------------------------------+
```

In M1 only "To evaluate", "Recently added" and empty states have data; the rest are placeholders wired to the index later.

### Pipeline: board

```
Pipeline   [Board | Table]   State v  Score v  Base v  Source v  Company [________]   23 jobs
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
| Found   4 | Evaluated | Tailoring | Ready   3 | Approved  | Applied 5 | Screening | Interview | Offer     |
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
| Vandelay  | Hooli     |           | Acme      |           | Umbrella  | Stark     |           |           |
| Sr SWE    | EM        |           | EM, Plat. |           | Staff Eng |           |           |           |
| -- . 3h   | 71 EM 1d  |           | 87 EM 2h  |           | 80 SSE 8d |           |           |           |
|           |           |           |           |           |           |           |           |           |
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
Closed: rejected 4 . withdrawn 1 . skipped 6 . expired 2                                   [Show closed]
Keys: arrows/J/K select . Enter open . M move to... . [ / ] move back/forward . S skip
```

Card = company, role, score, base, age. Drag-and-drop between columns; columns that the guards forbid are dimmed during the drag with the reason on hover.

### Pipeline: table

```
Pipeline   [Board | Table]   State v  Score v  Base v  Source v  Company [________]   23 jobs
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
|[ ]| Score | Company   | Role                      | State      | Base | Source | Location     | Added v|
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
|[x]|  87   | Acme      | Engineering Manager, Plat.| ready      | EM   | url    | Remote (EU)  | 16 Nov |
|[ ]|  80   | Umbrella  | Staff Engineer            | applied    | SSE  | lever  | Berlin       | 08 Nov |
|[ ]|  --   | Vandelay  | Senior SWE, Payments      | found      | -    | text   | Remote       | 16 Nov |
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
1 selected   [Move to v]  [Skip]  [Tag]                         J/K move . X select . Enter open
```

Sorting by header click; filters and sort persist in the URL so views are linkable/bookmarkable.

### Job dossier

```
< Pipeline    Acme  .  Engineering Manager, Platform                       [Move to v]  [...]
              87 strong . EM base . Remote (EU) . EUR 90-110k . found 16 Nov via URL
              found > evaluated > tailoring > (ready) > approved > applied > screening > ...
+--------------------------------------------------------------------------------------------+
| [Posting]  Evaluation   CV   Cover letter   Application   Interview   Timeline              |
+------------------------------------------------------------+-------------------------------+
| Snapshot fetched 16 Nov 10:42 . live . Open original  Raw  | NOTES                  [+ N]  |
|                                                            |  16 Nov  Referral via Ana     |
| About the role                                             | CONTACTS               [+]    |
| We are looking for an Engineering Manager to lead our      |  Jane Doe . recruiter         |
| platform team of 8 ...                                     | FILES                         |
|                                                            |  posting.md . posting.html    |
| What you'll do                                             |  status.yaml                  |
|  - Lead and grow ...                                       |  Open folder                  |
+------------------------------------------------------------+-------------------------------+
Keys: 1-7 switch tab . M move . N note . O open original
```

Raw `posting.html` is untrusted third-party HTML: it is only ever shown in a sandboxed iframe served with `Content-Security-Policy: sandbox`, never inside the app origin. In M1, tabs other than Posting and Timeline show an empty state that says which milestone fills them.

### CV review (M3, designed now so the data model supports it)

```
Review 1/3   Acme . Engineering Manager, Platform   87 strong   EM base          J/K prev/next job
+-----------------------+------------------------------------------------+-------------------------+
| POSTING               | TAILORED CV    [Diff vs base | Clean]          | PDF  (2 pages)          |
| Requirements          |                                                | +---------------------+ |
|  must  people mgmt  ok| ## Experience                                  | | Predrag M...        | |
|  must  Kubernetes   ~ | ### Engineering Manager . Acme . 2021 - now    | | Engineering Manager | |
|  strong platform   ok |     [ROLE-003] ok                              | | ...                 | |
|  nice  Go         gap |   - Grew the team from 4 to 14 engineers       | |                     | |
|                       |     [ACH-014] ok                               | |                     | |
| Highlights            | ~ - Led migration of 40 services to k8s        | |                     | |
|  "lead a team of 8"   |     [ACH-020] [ACH-021] WEAKENED               | |                     | |
|  "own the platform"   | + - Introduced on-call rotation and SLOs       | +---------------------+ |
|                       |     [ACH-031] ok                               |  page 1 of 2   < >      |
+-----------------------+------------------------------------------------+-------------------------+
Checks: numbers ok . companies ok . titles ok . dates ok    Verifier: 23 supported . 1 weakened . 0 unsupported
[A Approve]  [R Request changes]  [E Edit inline]  [B Switch base]  [S Skip]      ATS text round-trip ok
```

Hovering an evidence chip shows the bank entry; clicking a WEAKENED marker shows the verifier's reason and a suggested rewrite. Approve is disabled while anything blocking remains, and the bar says why.

---

## 6. M0 + M1 plan

Workflow: one GitHub issue per milestone (via `gh`), a branch per milestone (`m0-foundation`, `m1-jobs-pipeline`), commits referencing the issue, and a PR per milestone with `PR_DESCRIPTION.md`. CI must be green before moving on.

**M0** (done when the app opens on localhost showing an empty workspace)
- Tooling: package.json, tsconfigs, Biome, Vite, `.gitattributes`, `.gitignore`, CI (Windows + Linux, Node 24 + 26: lint, typecheck, test, build).
- `CLAUDE.md`, `README.md` (pitch, setup, career-ops credit), keep existing MIT `LICENSE`.
- CLI: `hirehound` (serve) and `hirehound init [path]`; flags `--workspace`, `--port`, `--no-open`, `--dev`.
- Workspace resolution per PRD section 6; init scaffolds folders plus commented example `preferences.yaml`, `contact.yaml`, `answers.yaml`; warns if the workspace is inside a git repo with a public remote.
- All Zod schemas above + state machine + score function, with unit tests.
- Index + watcher: builds from files at start, updates on change (debounced), broadcasts over SSE; polling fallback if `fs.watch` fails (e.g. Linux inotify limits).
- HTTP: router, JSON helpers, SSE, static serving, Vite middleware in dev, Host/Origin guard, 127.0.0.1 only.
- Web: shell (nav, top bar, routing, hotkeys, toasts, dark mode via tokens), empty Today/Pipeline, Settings showing workspace path and diagnostics.

**M1** (done when you can add a job in the UI and move it through states)
- Add job dialog: paste URL -> server fetches, saves raw HTML, extracts metadata (JSON-LD `JobPosting` first, then OpenGraph/title) and readable text -> you confirm/edit company, title, location -> job folder created. Or paste text directly. JS-rendered pages that return no content fall back to "paste the text" with a clear message (rendering through the browser comes with playwright-core in M2).
- Job folder naming, slugging (Windows reserved names, path length caps), collision suffixes.
- Pipeline board (drag-and-drop + keyboard) and table (sort, filter, multi-select, bulk move/skip).
- Dossier skeleton: header, state stepper, Posting tab, Timeline tab, notes, contacts, sandboxed raw view.
- Transitions API enforcing the state machine and guards; reasons captured for skip/withdraw/external apply.
- Live sync: editing `status.yaml` in an editor or via Claude Code updates the open UI within a second.
- Tests: schema round-trips, state machine table tests, slugging, extraction against saved fixture pages, HTTP API tests against a temp workspace.

---

## 7. Decisions (approved 2026-11-16)

1. **Node version:** develop on Node 24 (installed 24.22.3 via nvm-windows); CI runs 24 and 26.
2. **`@types/node`** added as a dev dependency (types only). TypeScript 7 defaults `types` to `[]`, so the server tsconfig lists `node` explicitly.
3. **No `@preact/preset-vite`:** JSX via Vite 8's built-in Oxc transform (`oxc.jsx.importSource: "preact"`). No fast-refresh; dev edits reload the page.
4. **CV dialect:** `###` for entry headings; no `#` in the body (the name comes from `contact.yaml`).
5. **Score computed in code** from the requirement matrix, with the 84 estimate cap and the 69 must-gap cap.
6. **"Applied externally"** is kept, clearly labelled, and excluded from the "100% have PDF + hash" metric.
7. **`accepted`** added as a terminal state after `offer`; declined offers use `withdrawn`.
8. **`cv.base.md`** snapshot stored per job (added to the data model).
9. **Branch + PR per milestone**, GitHub issue per milestone, commits reference the issue.
