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
    verification.json             # verifier result per claim                       (M3)
    cv.pdf                        # the exact PDF approved and sent                 (M3)
    cover-letter.md / .pdf        # optional                                        (M3)
    application.md                # answers used, confirmation snapshot             (M4)
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

Workspace overrides: `prompts/<task>.md` replaces a built-in prompt (`draft-bank`, `apply-answers`,
`draft-base`); `templates/<theme>.css` replaces a built-in CV theme (`classic`, `modern`).

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
  cv_sha256: <64 hex>
  base: em
application:                     # M4, or method: external from M1
  at: 2026-11-17T09:30:00+01:00
  method: manual                 # manual | assisted | external
  cv_sha256: <64 hex>            # must equal approval.cv_sha256 unless external
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

Guards:

- **G1** the tailored CV passes the deterministic checks and the verifier found no unsupported claim.
- **G2** `cv.pdf` exists; approval records its SHA-256.
- **G3** the SHA-256 of `cv.pdf` equals `approval.cv_sha256` (the PDF has not changed since approval).

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
