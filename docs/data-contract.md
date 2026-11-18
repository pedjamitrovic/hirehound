# Workspace data contract

The workspace is a user-owned folder, separate from the Hirehound install. Files in it are the
single source of truth: the app keeps only an in-memory index, so anything that edits these files
(the app, a text editor, Claude Code, a git pull) is supported, and the UI updates live.

Schemas are Zod definitions in `src/shared/schemas`; this document describes them for humans.
Any change to a file format updates this document in the same commit.

## Resolution

The first match wins:

1. `--workspace <path>` flag
2. `HIREHOUND_WORKSPACE` environment variable
3. `workspace:` in `~/.config/hirehound/config.yaml` (relative paths resolve against that folder)
4. `~/Documents/hirehound`

`~` expands on every OS. `hirehound` (serve) creates the workspace if the folder is missing or
empty, and refuses to use a non-empty folder that is not a workspace. `hirehound init <path>`
creates the layout in any folder and never overwrites an existing file.

`~/.config/hirehound/config.yaml` is app configuration, not workspace data:

```yaml
workspace: ~/Documents/hirehound   # optional
port: 4280                         # optional
```

## Layout

```
<workspace>/
  hirehound.yaml                  # marks the folder as a workspace (version, created_at)
  README.md                       # short guide for humans
  profile/
    contact.yaml                  # CV header details                         (M0 schema)
    preferences.yaml              # what you are looking for                  (M0 schema)
    answers.yaml                  # reusable application-form answers         (M0 schema)
    experience-bank.yaml          # source of truth for every claim           (M2)
    bases/<id>.md                 # base CVs in the CV dialect                (M2)
    onboarding.yaml               # open questions from onboarding            (M2)
    imports/                      # copies of the files you imported          (M2)
    stories.md                    # STAR+R story bank                         (M6)
  sources/portals.yaml            # watched companies and boards              (M5)
  prompts/                        # overrides of built-in prompts             (M2)
  templates/                      # overrides of CV / cover letter themes     (M2)
  ai-log.jsonl                    # one line per AI task: model, tokens, cost (M2)
  jobs/<job id>/
    posting.md                    # posting snapshot: frontmatter + readable text   (M1)
    posting.html                  # raw HTML as fetched, when added from a URL      (M1)
    status.yaml                   # state, history, notes, contacts                 (M1)
    evaluation.md                 # blocks A-G, requirement matrix, score           (M3)
    cv.base.md                    # the base CV exactly as used for tailoring       (M3)
    cv.md                         # tailored CV with evidence markers               (M3)
    changes.md                    # each change vs base and its bank entries        (M3)
    verification.json             # checks, verifier result per claim, PDF render   (M3)
    cv.pdf                        # the exact PDF approved and sent                 (M3)
    cover-letter.md               # optional cover letter, cited like the CV        (M4)
    cover-letter.verification.json # its checks, verdicts and render               (M4)
    cover-letter.pdf              # the exact letter approved and sent              (M4)
    application.md                # answers used, confirmation snapshot             (M4)
    confirmation.png              # the page after you submitted (assisted mode)    (M4)
    interview/                    # prep and debriefs                               (M6)
    ai-log.jsonl                  # model, tokens and cost per AI task              (M3)
```

Files and folders starting with `.` are ignored everywhere.

## Conventions

- **Encoding:** UTF-8. Hirehound writes LF line endings and reads CRLF or a BOM without complaint.
- **Versioning:** every YAML file (and YAML frontmatter) has `version: 1`.
- **Timestamps:** ISO 8601 local time with offset, `2026-11-16T10:42:00+01:00`. Dates are `YYYY-MM-DD`.
- **Writes are atomic:** the app writes a temp file (`<name>.tmp-<pid>-<hex>`) and renames it.
  Readers ignore temp files.
- **Unknown keys** are ignored but reported as warnings (so a typo is visible, not silent).
- **Invalid files** never crash the app. The problem appears in Settings (and on the job) with the
  file and line, and the rest of the workspace keeps working.

## hirehound.yaml

```yaml
version: 1
created_at: 2026-11-16T10:42:00+01:00
```

A folder that has `jobs/` and `profile/` but no manifest is also accepted as a workspace.

## profile/contact.yaml

The CV header is rendered from this file, never from CV Markdown.

| Key | Type | Notes |
|---|---|---|
| `name` | string | required |
| `email` | email | required |
| `phone` | string | optional |
| `location` | string | optional, e.g. `Belgrade, Serbia` |
| `links` | list of `{ label, url }` | e.g. LinkedIn, GitHub, website |

A file that is empty or fully commented out counts as "not set up".

## profile/preferences.yaml

| Key | Type | Default |
|---|---|---|
| `roles.seniority` | list of `mid, senior, staff, principal, manager, senior-manager, director, vp` | `[]` |
| `roles.include_title_keywords` | list of strings | `[]` |
| `roles.exclude_title_keywords` | list of strings (hard filter in discovery) | `[]` |
| `location.based_in` | `{ country: ISO 3166 alpha-2, city? }` | required |
| `location.remote` | `remote-only`, `hybrid-ok`, `onsite-ok` | `hybrid-ok` |
| `location.acceptable_locations` | list of strings, e.g. `Remote (EU)` | `[]` |
| `location.timezone` | IANA zone, e.g. `Europe/Belgrade` | required |
| `location.acceptable_utc_offsets` | `[min, max]` hours | optional |
| `location.work_authorization` | list, e.g. `[RS, EU]` | `[]` |
| `location.needs_sponsorship_elsewhere` | boolean | `true` |
| `location.open_to_relocation` | boolean | `false` |
| `compensation.floor`, `compensation.target` | salary range (below) | optional |
| `company.sizes` | list of `1-10, 11-50, 51-200, 201-1000, 1001-5000, 5000+` | `[]` (any) |
| `company.include_industries` / `exclude_industries` / `exclude_companies` | lists of strings | `[]` |
| `deal_breakers` | list of free-text strings, judged by the evaluator | `[]` |
| `scoring.threshold` | 0-100; the guardrail warns below it | `70` |
| `cover_letter.policy` | `always`, `when-requested`, `never` | `when-requested` |
| `apply.mode` | `manual`, `assisted` | `manual` |
| `cv.max_pages` | 1-4 | `2` |
| `cv.paper` | `a4`, `letter` | `a4` |

Salary range: `{ min?, max?, currency: ISO 4217, period: year|month|day|hour (default year), raw? }`
with `min <= max`.

## profile/answers.yaml

```yaml
version: 1
answers:
  - id: notice-period            # lowercase, unique
    question: What is your notice period?
    aliases: [When can you start?]
    answer: One month
    kind: text                    # text | yes-no | number | choice | url | date
    tags: [availability]
    sensitive: false              # true: never filled in without asking (EEO, disability, ...)
    updated_at: 2026-11-16
```

## profile/experience-bank.yaml

The single source of truth for every claim a CV makes. Each entry has a permanent id that CVs cite
in evidence markers. Ids are never reused: `id_counters` records the highest number handed out per
prefix, so deleting ACH-014 never lets a later entry become ACH-014.

```yaml
version: 1
id_counters: { ROLE: 3, ACH: 21, SKL: 2 }
roles:
  - id: ROLE-003
    company: Acme Robotics
    title: Engineering Manager
    start: 2021-03            # YYYY or YYYY-MM; left out when no source states it
    end: present              # YYYY, YYYY-MM or present
    location: Berlin, Germany
    employment_type: full-time   # full-time | part-time | contract | freelance | internship
    summary: Owned the internal developer platform used by 120 engineers.
    confirmed: true
    source: imports/2026-11-18_cv.pdf
    achievements:
      - id: ACH-014
        text: Grew the platform group from 4 to 14 engineers in 18 months
        metrics: [4 to 14 engineers, 18 months]    # figures exactly as stated
        skills: [hiring, org design]
        detail: Context for verification; not printed as is.
        confirmed: true
projects: []        # PRJ: name, role, start, end, url, summary, achievements
education: []       # EDU: institution, degree, field, start, end, location, detail
certifications: []  # CERT: name, issuer, date, expires, url
skills: []          # SKL: name (the group), items
languages: []       # LANG: name, level
awards: []          # AWD: name, issuer, date, detail
```

Every entry also has `confirmed` (default `false`), `source` and `tags`. **Entries drafted by AI start
unconfirmed, and CVs are only ever built from confirmed entries.** Editing an entry yourself in the app
confirms it. `source` is an imported file (`imports/...`), `answers` (from onboarding questions) or
`manual`. Ids are unique across the whole file and each kind has its prefix (ROLE, ACH, PRJ, EDU, CERT,
SKL, LANG, AWD). The app edits the file one entry at a time and keeps comments elsewhere in it.

## profile/onboarding.yaml

Open questions from onboarding, and contact details found in imported files:

```yaml
version: 1
contact_suggestion: { name: Alex Example, location: Berlin, links: [] }
questions:
  - id: Q-001
    entry: ACH-015          # the bank entry it is about, if any
    question: What changed after on-call was introduced?
    why: A measurable result makes the claim stronger.
    answer: Incidents dropped by 40%
    status: open            # open | applied | skipped
```

## profile/imports/

Copies of the files you imported during onboarding (`<date>_<name>.<ext>`: .pdf, .docx, .md, .txt or a
LinkedIn export .zip), kept so every drafted entry can point at its source. Only the AI provider you
configured ever sees their content. From a LinkedIn export only career data is read (profile,
positions, education, skills, certifications, languages, projects, honors, publications, volunteering,
received recommendations); birth date, address, messages and connections never are.

## profile/bases/<id>.md

Base CVs in the CV dialect (`docs/cv-dialect.md`). The id is the file name stem. Frontmatter: `id`,
`label`, `track` (management | ic), `target_titles`, `headline`, `emphasis`, `theme` (classic | modern).
The app checks every evidence id against the bank and warns about unconfirmed ones.

## ai-log.jsonl

One JSON line per AI task at the workspace root: `at`, `task`, `engine`, `model`, `ok`,
`prompt_override`, token counts, `cost_usd` (an estimate for the API engine, Claude Code's own figure
for that engine), `duration_ms`, and `error` on failure. It never contains prompts, files or outputs.

## App settings (outside the workspace)

`~/.config/hirehound/config.yaml` may also hold `ai: { engine: anthropic-api | claude-code, model }`.
An Anthropic API key comes from `ANTHROPIC_API_KEY` or `~/.config/hirehound/credentials.yaml`
(`anthropic_api_key`, written readable by your user only). Neither is ever written to the workspace.

Assisted apply (M4) uses its own browser profile in `~/.config/hirehound/browser-profile`: you sign
in to job sites there once; your everyday browser profile is never used.

Workspace overrides: `prompts/<task>.md` replaces a built-in prompt (`draft-bank`, `apply-answers`,
`draft-base`, `evaluate`, `tailor`, `verify`, `cover-letter`, `map-form`); `templates/<theme>.css` replaces a built-in CV theme
(`classic`, `modern`). The CV document turns off contextual font alternates after the theme CSS:
some glyph variants map to private code points and would come out of the PDF as garbage for an ATS.

## Job folders

**Id (folder name):** `<YYYY-MM-DD>_<company slug>_<role slug>`, where the date is the day the job
was found and slugs are lowercase ASCII letters, digits and hyphens (company up to 30 characters,
role up to 48). Collisions get `-2`, `-3`, ... on the role part. Diacritics are folded; names with
no Latin letters become `x-<hash>`. The id never changes after creation, even if the company or
title is corrected later. Folders under `jobs/` that do not match this pattern are ignored with a
warning.

### posting.md

YAML frontmatter plus the posting as readable text (headings as `##`, bullets as `-`).

| Key | Type | Notes |
|---|---|---|
| `company`, `title` | string | required |
| `url` | http(s) URL | absent for pasted text without a link |
| `source` | `manual-url`, `manual-text`, `greenhouse`, `lever`, `ashby`, `workable`, `smartrecruiters`, `linkedin-email`, `browser` | |
| `source_ref` | string | provider-scoped id, e.g. `greenhouse:acme:4012345`; set when the link is a known ATS; dedupe key |
| `location` | string | optional |
| `workplace` | `remote`, `hybrid`, `onsite`, `unknown` | default `unknown` |
| `employment_type` | `full-time`, `part-time`, `contract`, `internship`, `unknown` | default `unknown` |
| `salary` | salary range | only when stated in the posting |
| `posted_at`, `valid_through` | date | when stated |
| `fetched_at` | timestamp | required |
| `text_sha256` | hex SHA-256 of the normalised body text | change and repost detection |

`posting.html` is the raw page exactly as fetched. It is untrusted third-party content: the app
only ever serves it with `Content-Security-Policy: sandbox` and never renders it in its own origin.

### status.yaml

```yaml
version: 1
state: evaluated
base: em                         # chosen base profile, once known
history:                         # append-only
  - { at: 2026-11-16T10:42:00+01:00, from: null, to: found, by: user }
  - { at: 2026-11-16T11:05:00+01:00, from: found, to: evaluated, by: user }
notes:
  - { at: 2026-11-16T11:06:00+01:00, text: Referral via Ana }
contacts:
  - { name: Jane Doe, role: recruiter, email: jane@example.com }
tags: [remote-eu]
approval:                        # M3: written when you approve the PDF
  at: 2026-11-17T09:00:00+01:00
  cv_sha256: <64 hex>            # SHA-256 of cv.pdf exactly as approved
  base: em
  override_reason: Referral      # only when approved below scoring.threshold
cover_letter_approval:           # M4: the cover letter's own approval
  at: 2026-11-17T09:10:00+01:00
  sha256: <64 hex>               # SHA-256 of cover-letter.pdf exactly as approved
application:                     # M4, or method: external from M1
  at: 2026-11-17T09:30:00+01:00
  method: manual                 # manual | assisted | external
  cv_sha256: <64 hex>            # must equal approval.cv_sha256 unless external
  cover_letter_sha256: <64 hex>  # when the approved cover letter was sent too
```

- `by` is `user`, `system` or `ai`. `reason` is required for `skipped`, `withdrawn` and external
  applications.
- Contact roles: `recruiter`, `hiring-manager`, `interviewer`, `referral`, `other`.
- `state` is authoritative. If it disagrees with the last history entry (a hand edit), the app shows
  a warning and records the next move from `state`.

## States

```
found -> evaluated -> tailoring -> ready -> approved -> applied -> screening -> interviewing -> offer -> accepted
```

Closed states: `accepted` (final), `rejected`, `withdrawn`, `skipped`, `expired`.

| From | Allowed moves |
|---|---|
| found | evaluated, skipped, expired |
| evaluated | tailoring, found (re-evaluate), skipped, expired |
| tailoring | ready [G1], evaluated, skipped, expired |
| ready | approved [G2], tailoring (request changes), skipped, expired |
| approved | applied [G3], ready (revoke approval), skipped, expired |
| applied | screening, interviewing, offer, rejected, withdrawn |
| screening | interviewing, offer, rejected, withdrawn |
| interviewing | offer, rejected, withdrawn |
| offer | accepted, rejected (rescinded), withdrawn (declined) |
| rejected, withdrawn, skipped, expired | reopen to the last open state in the history |
| any of found..approved | applied with `method: external` (applied outside Hirehound; reason required) |

Guards, all read from the job's files:

- **G1** `verification.json` describes the current `cv.md` (its `cv_sha256` matches), has no
  error-level check and no claim the verifier found unsupported.
- **G2** `cv.pdf` exists and is the render recorded in that `verification.json` (`render.pdf_sha256`
  matches); approval records its SHA-256.
- **G3** the SHA-256 of `cv.pdf` equals `approval.cv_sha256` (the PDF has not changed since approval).

Automatic moves are recorded with `by: system`: evaluating a `found` job moves it to `evaluated`;
tailoring moves `evaluated` or `ready` to `tailoring`; a check that passes moves `tailoring` to
`ready`, and one that fails moves `ready` back to `tailoring`, so Ready always means verified.
Revoking an approval (approved -> ready) removes `approval`; the history keeps the record. Approving
also needs the cited bank entries unchanged since the check, and a reason when the fit score is
below `scoring.threshold`.

External applications are labelled as such and excluded from the "every application has its exact
PDF and approval hash" guarantee. The state machine is `src/shared/states.ts`; the API enforces it
and the UI uses the same code to explain blocked moves.

## evaluation.md (M3)

YAML frontmatter holds the full structured evaluation (blocks A-G as produced by the model and
validated by `EvaluationOutput`) plus `score`, `band`, `engine { id, model }`, `created_at`,
`posting_sha256` and `bank_sha256` (so a changed posting or bank marks the evaluation stale). The
Markdown body is a human-readable rendering of the same data. The frontmatter is authoritative.

The fit score is computed by code from the requirement matrix, never by the model:

- weights: must 3, strong 2, nice 1; match: met 1, partial 0.5, gap 0
- score = round(100 x earned / total)
- if the score over JD-stated requirements alone (`jd-wording`, `jd-structure`) is below 85, the
  score is capped at 84: estimated requirements cannot carry a role into the top band
- any `must` with `gap` caps the score at 69
- bands: 85-100 strong, 70-84 good, 50-69 stretch, 0-49 weak

The app recomputes the score from the matrix whenever it reads the file, so a hand edit of a
requirement's `match` is honoured. Evidence ids cite confirmed bank entries only.

## cv.base.md, cv.md and changes.md (M3)

`cv.base.md` is a byte-for-byte copy of the base CV the tailoring started from. `cv.md` is the
tailored CV in the CV dialect (`docs/cv-dialect.md`); every entry heading, paragraph and bullet
cites confirmed bank entries. Its frontmatter: `job`, `base`, `base_sha256` (of the base file
used), `headline`, `generated_at`, `engine { id, model }`, `theme` and `notes` (what the tailoring
emphasised and left out). You may edit `cv.md` in the app or by hand; any edit makes the
verification stale until the CV is checked again.

`changes.md` is a human-readable record of one tailoring run: the request (when you asked for
changes), the reasons given for each change with their bank ids, and the claims changed, added and
removed against the base. Nothing reads it back.

## verification.json (M3)

Everything known about one exact version of `cv.md`:

```json
{
  "version": 1,
  "cv_sha256": "<sha256 of cv.md>",
  "bank_sha256": "<sha256 of experience-bank.yaml at check time>",
  "checked_at": "2026-11-18T20:40:45+01:00",
  "engine": { "id": "anthropic-api", "model": "claude-opus-5-5" },
  "checks": [
    { "check": "numbers", "n": 4, "line": 18, "severity": "error",
      "message": "\"16\" does not appear in ACH-001" }
  ],
  "claims": [
    { "n": 0, "line": 7, "text": "...", "ev": ["ROLE-001"], "key": "<sha256>",
      "verdict": "supported", "reason": "...", "verified_at": "..." },
    { "n": 3, "line": 12, "text": "...", "ev": ["ACH-003"], "key": "<sha256>",
      "verdict": "weakened", "reason": "...", "suggestion": "...", "verified_at": "..." }
  ],
  "render": {
    "pdf_sha256": "<sha256 of cv.pdf>", "pages": 2, "max_pages": 2,
    "rendered_at": "...", "theme": "classic",
    "ats": { "coverage": 1, "missing": [], "garbled": 0 }
  }
}
```

- `checks`: the deterministic checks (`format`, `evidence`, `numbers`, `companies`, `titles`,
  `dates`). Errors block G1. Numbers in a claim must appear in the cited entries (or their role or
  project); entry headings must carry the cited role's title and company exactly, and only dates
  the bank has; a company the bank knows may only be mentioned by a claim citing it.
- `claims`: the faithfulness verifier's verdict per claim (`supported`, `weakened`, `unsupported`).
  The verifier sees each claim and the full text of the entries it cites, never the posting or the
  tailoring notes. `key` hashes the claim text and that evidence: an unchanged claim keeps its
  verdict, so only changed claims are sent again.
- `render`: the PDF written with this check, and the ATS round trip: the share of the CV's words
  read back out of the PDF text, words that did not come back, and characters that came out as
  private-use or replacement code points. Over the page limit, below 98% or any garbled character
  is a warning.

`engine` is null when every verdict was reused. `jobs/<id>/ai-log.jsonl` repeats the workspace
`ai-log.jsonl` lines for that job (with `job` set), for the cost per job.

## cover-letter.md (M4)

Paragraphs in the CV dialect, no headings or bullets, each ending with an evidence marker. The
greeting and the sign-off live in the frontmatter, and the template adds the date, the company and
your name:

```yaml
job: 2026-11-18_initrode-logistics_engineering-manager-developer-platform
angle: fit                      # fit | impact | motivation | brief
greeting: Dear Initrode Logistics hiring team,
closing: Kind regards,
generated_at: 2026-11-18T21:34:00+01:00
engine: { id: anthropic-api, model: claude-opus-5-5 }
theme: classic                  # the CV's theme
notes: Leads with team growth and reliability.
```

It is checked exactly like the CV, into `cover-letter.verification.json` (same format as
`verification.json`, page limit 1), with one difference: statements about the company or the role
may rest on the posting, so the deterministic checks and the verifier also get the posting text.
Statements about you still need cited bank entries. Approving it records
`cover_letter_approval` in `status.yaml`; editing the letter makes that approval stale, because
the PDF changes. Writing or changing a cover letter is refused once the application was recorded.

## application.md (M4)

The permanent record of what you sent. Hirehound writes it when you confirm "I submitted"; it never
submits a form itself. The frontmatter is authoritative:

```yaml
version: 1
applied_at: 2026-11-18T21:25:00+01:00
method: assisted                # manual | assisted
url: https://jobs.example.com/initrode/123/apply
cv: { file: cv.pdf, sha256: <64 hex> }               # always the approved PDF (guard G3)
cover_letter: { file: cover-letter.pdf, sha256: <64 hex> }   # only when sent
answers:                        # what assisted mode filled in, field by field
  - question: What is your notice period?
    answer: One month
    source: library             # profile | library | job | you | document
    answer_id: notice-period
confirmation:
  captured_at: 2026-11-18T21:25:00+01:00
  url: https://jobs.example.com/initrode/123/thanks
  title: Thank you for applying
  text: Thanks for applying to Initrode Logistics!   # pasted (manual) or read from the page
  screenshot: confirmation.png                        # assisted mode
```

The body repeats it for reading. Recording the application moves the job from approved to applied
(guard G3) and sets `application` in `status.yaml`; if that move is refused, the files are removed
again.

Assisted mode never answers equal-opportunity or demographic questions, questions about health or
history, consent or terms, or answers marked `sensitive` in `answers.yaml`, whatever the model
suggests: they come back to you. Answers you type there can be added to `profile/answers.yaml`
(a question already in the library gets its answer updated; comments are kept).
