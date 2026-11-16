# PRD: Hirehound

> A local-first, web-based, Claude-powered job application workbench: discover relevant roles, evaluate each one honestly, tailor a CV from a verified experience bank, approve it in a great UI, apply, and keep a permanent record of exactly what was sent.

Status: Draft v0.3 · Owner: Predrag · Last updated: 2026-11-16

Changelog
- v0.3: Renamed to Hirehound. Lightweight stack (D6): Preact + plain CSS, node:http, no DB, ≤ 5 runtime deps. CVs stay in Markdown; output PDF only; multi-format import (D7).
- v0.2: Web UI is now a first-class requirement (terminal is secondary). Incorporated learnings from career-ops. Stack moved to TypeScript. Milestones re-cut.
- v0.1: Initial CLI-first draft.

---

## 1. Problem

Hiring pipelines in the AI era are flooded with applications, and generic CVs get filtered by ATS keyword matching and recruiters skimming for fit. Candidates are expected to tailor every CV, but doing it by hand is slow and hard to track. Weeks later, when a recruiter calls, the candidate often can't remember which CV they sent or what the (since-deleted) ad said.

LLMs tailor CVs well, but naïve use creates a new risk: **fabricated or inflated experience** the candidate can't defend in an interview.

Existing open-source tools (notably **career-ops**, see §3) solve much of the pipeline, but they are terminal-first: career-ops' primary interfaces are AI CLIs and a terminal dashboard, with a web UI that is still an opt-in alpha. Reviewing a CV diff, comparing 30 jobs, or editing an experience bank are visual, comparative tasks: a terminal is the wrong medium for them, and it excludes most non-developer job seekers.

## 2. Goals

1. **Great web UX.** The primary interface is a polished local web app. Every core flow (review, approve, apply, track) is designed for the browser first.
2. **Tailor without lying.** Every CV claim traces to an entry in the experience bank; a separate verification pass proves it.
3. **Human in the loop.** Nothing is submitted without explicit approval of the specific CV for the specific job. The user always presses Submit.
4. **Permanent record.** Per job: posting snapshot, evaluation, exact CV/cover letter sent (source + PDF), status timeline, interview notes.
5. **Generic and shareable.** Anyone can install it, onboard in the UI, and use it. No personal data in the tool repo.
6. **Multiple base profiles** (e.g. Engineering Manager, Senior SWE), chosen per job.
7. **Files are the source of truth.** Plain Markdown/YAML in a workspace folder, so Claude Code / Cowork can operate on the same data and the user can back it up with git.

**Guiding principle (borrowed from career-ops):** *apply better to fewer.* Signal over volume.

## 3. Prior art and what we take from it

**career-ops** (github.com/career-ops-hq/career-ops, MIT, ~82k★) is the closest existing tool. It runs inside AI CLIs, has a Go TUI dashboard and an alpha opt-in web UI. We adopt these ideas, with credit in the README:

| Idea from career-ops | How we use it |
|---|---|
| Multi-block evaluation (summary, CV match, level, comp, personalisation, interview prep, legitimacy) | §7.2 Evaluation, rendered as a scannable card in the UI |
| Weighted requirements labelled by evidence source (JD wording / structure / estimate); estimates can't reach top band | Fit score model, §7.2 |
| Legitimacy check: liveness verification, repost/ghost-job detection | §7.1 + §7.2 |
| Work-authorisation / sponsorship flag | §7.2 (critical for cross-border applicants) |
| Score guardrail: advise against applying below threshold, user can override | §7.4 |
| Anti-fabrication code check on numbers/facts; title check | §7.3 deterministic checks (we make title changes **blocking**) |
| They lack a faithfulness check on rewording (open issue) | Our differentiator: LLM verifier with evidence links, §7.3 |
| Story bank (STAR+R), interview prep, practice, debrief | §7.7 |
| Follow-up cadence, reply classification, outcome tracking → calibration | §7.6, §7.8 |
| Portal scanner config with many ATS providers; LinkedIn alert-email import | §7.1 |
| Data root resolution + canonical state file + data contract doc | §6, §8 |
| Archetypes / framing | Our "base profiles" |
| Prompts as editable files ("self-customising") | Prompts live in workspace, editable in UI, §8 |
| Batch processing with parallel workers | Job queue, §8 |
| Update with diff preview | Non-goal for v1, noted for later |

**Where we differ:** web-first UX; evidence-linked tailoring with a blocking faithfulness verifier; multiple base profiles as a core concept; approval locked to the exact PDF hash; a per-job "dossier" designed for the moment a recruiter calls.

## 4. Non-goals (v1)

- Mass auto-applying, auto-submit, CAPTCHA/anti-bot bypass, or violating job sites' ToS.
- Hosted SaaS / multi-tenant accounts. v1 runs on the user's machine (`localhost`).
- Sending email on the user's behalf (drafts only).
- Mobile-optimised UI (responsive enough to read, not to work in).

## 5. Users

- **Primary:** experienced tech professional (EM / senior IC) applying to a focused set of roles; comfortable installing a dev tool but wants a visual workflow.
- **Secondary:** any job seeker who can run one install command; contributors who fork and adapt.

## 6. Data model (workspace)

The workspace is a user-owned folder, separate from the tool install. Resolution: `--workspace` flag > `HIREHOUND_WORKSPACE` env > `~/.config/hirehound/config.yaml` > OS default (`~/Documents/hirehound`).

```
<workspace>/
  profile/
    experience-bank.md      # single source of truth; entries have stable IDs (e.g. ACH-014)
    bases/em.md, sse.md     # base profiles: frontmatter (track, target titles, emphasis) + CV in Markdown
    preferences.yaml        # locations, remote, timezones, salary floor, seniority, company size,
                            # include/exclude industries, deal-breakers, score threshold,
                            # cover-letter policy, apply mode
    contact.yaml            # header info
    answers.yaml            # reusable application-form answers
    stories.md              # STAR+R story bank, linked to bank entries
  sources/
    portals.yaml            # watched companies + ATS provider + queries
  prompts/                  # user-editable overrides of default prompts
  templates/                # optional CV/cover-letter theme overrides
  jobs/<YYYY-MM-DD>_<company>_<role>/
    posting.md / posting.html   # snapshot (URL, fetched_at, text, salary, location)
    evaluation.md               # blocks A–G, fit score, requirement matrix with evidence IDs
    cv.md / cv.pdf              # tailored CV (Markdown, bullets carry evidence IDs) and the exact PDF sent
    changes.md                  # each change vs base → supporting bank entry IDs
    verification.json           # verifier result per claim
    cover-letter.md/.pdf        # optional
    application.md              # form answers used, confirmation snapshot
    status.yaml                 # state + timestamped history + notes + contacts
    interview/                  # prep, debriefs
```

Canonical states: `found → evaluated → tailoring → ready → approved → applied → screening → interviewing → offer | rejected | withdrawn | skipped | expired`.

## 7. Functional requirements

### 7.1 Discover
- Source adapters returning normalised postings. v1: **manual** (paste URL/text/screenshot in UI), **ATS public APIs** (Greenhouse, Lever, Ashby; Workable/SmartRecruiters stretch), **LinkedIn job-alert email import** (paste/upload .eml), **browser-assisted search** via the user's own browser session.
- Dedupe across sources and history; hard-filter deal-breakers; **liveness check** on new postings; repost detection.
- Scheduled scans (in-app scheduler while running + documented OS-level schedule). Discovery only creates `found` jobs.

### 7.2 Evaluate
Produce `evaluation.md` with blocks:
- **A Role summary** (incl. hidden signals, e.g. "EM title, 50% hands-on").
- **B Fit:** requirement matrix: each requirement weighted and labelled by evidence source (JD wording / JD structure / estimate); each matched to bank entry IDs or marked as a gap. Fit score 0–100; estimate-only matches capped below the top band.
- **C Level & base choice:** which base profile and why.
- **D Compensation** signal (stated or researched, clearly labelled).
- **E Work authorisation / location** compatibility flag.
- **F Legitimacy:** live, repost, ghost-job signals.
- **G Recommendation:** apply / stretch / skip, with one-line reason.

### 7.3 Tailor & verify
- Tailor from chosen base using only bank facts; mirror JD vocabulary where truthful; respect length (default 2 pages).
- `changes.md` maps every change to bank entry IDs.
- **Deterministic checks (blocking):** numbers/metrics, company names, dates, and job titles must match the bank exactly.
- **Faithfulness verifier (blocking):** separate model call with no access to the tailoring rationale; checks every sentence against cited bank entries; outputs supported / weakened / unsupported. Unsupported → job can't reach `ready`.
- Optional cover letter (policy: always / when requested / never), with selectable angle and its own approval.
- Deterministic PDF render; ATS readability check (text extraction round-trip).

### 7.4 Review & approve (hero flow)
- Queue of `ready` jobs; score guardrail warns below threshold (overridable with reason).
- Review screen: posting ↔ tailored CV side by side; diff vs base; every changed line shows an **evidence chip** (hover → bank entry); verifier status per line; live PDF preview.
- Actions: approve · request changes (free text → re-tailor) · edit inline (re-render + re-verify) · switch base · skip (reason captured for calibration).
- Approval stores timestamp + SHA-256 of `cv.pdf`; apply refuses if the PDF changed after approval.

### 7.5 Apply
- Modes: `manual` (UI shows checklist: open link, download PDF, copy-ready answers) and `assisted` (agent fills the form in a visible browser and uploads the PDF, **stopping before Submit**).
- Unknown form questions surface in the UI; answers can be saved to `answers.yaml`.
- User confirms "I submitted" → `applied`, confirmation snapshot stored.

### 7.6 Track & follow up
- Pipeline views: Kanban by state and a dense sortable table; filters (state, score, base, source, company, date).
- Timeline per job; notes and contacts; follow-up reminders with configurable cadence; paste a recruiter reply → classified and state suggested.

### 7.7 Interview
- Per-job prep: likely questions, mapped STAR+R stories, the exact CV sent, company research, questions to ask; post-interview debrief capture.

### 7.8 Insights & calibration
- Funnel (found → applied → screen → interview → offer) by base profile, source, score band.
- Skip/reject reasons feed suggested preference and weighting tweaks (user approves changes).

### 7.9 Onboarding
- Wizard: upload existing CVs (.md, .txt, .pdf, .docx) / LinkedIn export (.zip) / reviews → AI drafts the experience bank and base profiles → guided interview (chat) to fill gaps and quantify achievements → user reviews the bank in a structured editor → preferences form → first job.

## 8. Architecture

- **Local web app.** One command (`npx hirehound`) starts a local server and opens the browser. Optional desktop wrapper later.
- **Lightweight by principle.** Prefer Node built-ins and the web platform; every runtime dependency must justify itself and should itself have zero dependencies. Target: **≤ 5 runtime dependencies**.
- **Runtime:** Node.js 24 LTS minimum (26 LTS recommended). TypeScript runs natively via Node's built-in type stripping, so the server needs no build step (use erasable-only TS: no enums/namespaces; `erasableSyntaxOnly` in tsconfig).
- **Single package, not a monorepo:** `src/server`, `src/web`, `src/shared`; npm (no pnpm/yarn).
- **Backend:** `node:http` + a ~100-line router; Server-Sent Events for live progress; in-process job queue and scheduler (`setTimeout`); `fs.watch` (recursive) for live file sync. No database: the index is an in-memory map rebuilt from files at startup (fine up to thousands of jobs).
- **Frontend:** **Preact** + `@preact/signals` (React-compatible API, ~4 KB), hand-rolled router (a few dozen lines) and **plain modern CSS** (custom properties, nesting, container queries) with a small in-house component set. No Tailwind, no component library, no state library.
- **Runtime dependencies (the whole list):**
  - `preact` + `@preact/signals`: UI
  - `zod`: schemas for workspace files and **validation of every LLM output** (zero deps)
  - `yaml`: YAML/frontmatter parsing (zero deps)
  - `playwright-core`: PDF rendering and assisted apply, **driving the Chrome or Edge already installed** on the machine (no 150 MB browser download; Edge ships with Windows)
- **Dev dependencies:** `typescript` (type-check only, `tsc --noEmit`), `vite` (+ Preact preset) for the frontend bundle, `@biomejs/biome` (lint + format in one binary). Tests use the built-in `node:test` runner.
- **CV format:** CVs (base and tailored) are **Markdown** in a small, documented dialect (frontmatter, `#`/`##` headings, paragraphs, bullet lists, bold/italic, links). Each bullet may end with an evidence marker as an HTML comment, e.g. `- Grew the team from 4 to 14 engineers <!-- ev: ACH-014 -->`, which is invisible in the PDF but powers evidence chips, diffing and verification. Parsed by a small in-house parser for that dialect (no Markdown library); rendered to HTML with template literals and exported to **PDF only**.
- **Importing existing CVs (onboarding):** accepts `.md`, `.txt`, `.pdf`, `.docx` and a LinkedIn data export (`.zip`) as source material for the experience bank and base CVs. No parsing libraries: `.md`/`.txt` are read directly; `.docx` and `.zip` via a tiny in-house ZIP reader on top of `node:zlib` (extract `word/document.xml` / CSVs, strip XML); `.pdf` is sent to Claude as a document (the Messages API reads PDFs natively, and Claude Code can read them too).
- **Secrets:** API key from env var or a config file outside the workspace with user-only permissions (OS keychain later; keychain libraries need native modules).
- **AI engine adapter.** All LLM work goes through one interface with implementations: (a) **direct Anthropic Messages API via `fetch`** (API key, zero dependencies): default for evaluate/tailor/verify, using structured outputs validated by Zod; (b) **headless Claude Code** (spawn `claude -p`, zero dependencies) to reuse an existing Claude Code login; (c) the **Claude Agent SDK** only if/when agentic flows (assisted apply, browsing discovery) need it - loaded lazily as an optional dependency. Each task (evaluate, tailor, verify, …) is a prompt file + Zod output schema; outputs are validated before being written.
- **Job queue.** Background tasks with concurrency limits, progress streamed to the UI, cost/token usage shown per job.
- **Browser automation.** `playwright-core` launching the installed Chrome/Edge with a persistent, headed, app-owned profile (user logs into job sites once). Pluggable to allow an existing browser MCP.
- **Claude Code interop.** Ship a small Claude Code plugin/skill set that operates on the same workspace, so power users can drive it from the terminal; the UI remains primary.
- **Templates.** 2 ATS-safe themes (single column, real text, standard headings). Theme overrides in workspace.

## 9. UX principles & key screens

Principles: review in one glance; evidence always one hover away; no dead ends (every AI output editable); show progress, never a spinner without context; keyboard shortcuts for queue triage (J/K, A approve, S skip); calm, dense, professional look.

Screens:
1. **Today**: what needs your attention (jobs to review, follow-ups due, upcoming interviews, scan results).
2. **Pipeline**: Kanban ↔ table toggle, filters, bulk actions.
3. **Job dossier**: header (company, role, score, state) + tabs: Posting · Evaluation · CV · Cover letter · Application · Interview · Timeline.
4. **CV review**: side-by-side diff with evidence chips, verifier markers, inline edit, PDF preview, approve bar.
5. **Apply**: checklist / live assisted-apply status, form answers, "I submitted" confirmation.
6. **Profile**: experience bank structured editor (roles → achievements with metrics, tags, IDs), base profiles, stories, answers, preferences.
7. **Sources**: portals, scan history, schedule.
8. **Insights**: funnel and calibration suggestions.
9. **Settings**: AI engine & keys, workspace path, prompts, templates.

## 10. Privacy & safety
- No personal data in the tool repo; no telemetry; no project backend. Server binds to `127.0.0.1` only.
- API key from env var or a user-only config file outside the workspace; never written into the workspace.
- CV data goes only to the AI provider the user configured.
- Warn if the workspace sits inside a public git repo; recommend a private repo for backup.
- Never auto-submit; never invent experience; never bypass anti-bot measures.

## 11. Success metrics
- New user: install → onboarding → first tailored, approved CV in < 30 min.
- Found → ready in < 5 min per job; review in < 2 min.
- 0 unsupported claims in approved CVs.
- 100% of applied jobs have posting snapshot + exact PDF + approval hash.
- Interview rate tracked per base profile and score band.

## 12. Milestones

| M | Scope | Done when |
|---|---|---|
| **M0** | Single-package repo, CI, lint/test, CLAUDE.md, app shell (layout, nav, routing), workspace resolution & `init`, Zod schemas, file watcher + index | App opens on localhost showing an empty workspace |
| **M1** | Manual job add (URL/text), posting snapshot, Pipeline (Kanban + table), Job dossier skeleton, state machine | Add a job in UI, move it through states |
| **M2** | AI engine adapter; onboarding wizard (import → bank → bases); Profile editor; PDF templates + render | User has bank + 2 base CVs with PDF preview |
| **M3** | Evaluate (A–G) + Tailor + deterministic checks + verifier; CV review screen; approval hashing | Real posting → approved, verified CV |
| **M4** | Apply (manual + assisted, stop before Submit), answers library, confirmation snapshot | Real application submitted through the flow |
| **M5** | Discovery: ATS adapters, portals, dedupe, liveness, repost detection, LinkedIn alert import, scheduler | Scheduled scan fills the pipeline with filtered, live jobs |
| **M6** | Follow-ups, reply classification, interview prep/debrief, story bank, Insights | Prep pack for an applied job; funnel view |
| **M7** | Claude Code plugin interop, docs site, packaging (npx), contribution guide | Outside user installs and succeeds from README |

## 13. Decisions log

| # | Decision | Date |
|---|---|---|
| D1 | Own project; career-ops is credited prior art, not a dependency | 2026-11-16 |
| D2 | AI engine: API key as default (direct Messages API, per D6), headless Claude Code as alternative adapter; Agent SDK only if agentic flows need it | 2026-11-16 |
| D3 | Delivery: localhost web app via `npx`; desktop wrapper possibly later | 2026-11-16 |
| D4 | Assisted apply uses an app-owned Playwright browser profile (user logs into job sites there once) | 2026-11-16 |
| D5 | Name: Hirehound (repo `hirehound`) | 2026-11-16 |
| D6 | Lightweight stack: Node 24+ with native TS, node:http, Preact + plain CSS, ≤ 5 runtime deps (preact, @preact/signals, zod, yaml, playwright-core), no database | 2026-11-16 |
| D7 | CVs live in Markdown (with invisible evidence markers); tailored CVs are exported to PDF only; .md/.txt/.pdf/.docx/LinkedIn export accepted as input for building base CVs | 2026-11-16 |
| D8 | Public GitHub repo, free for everyone under the MIT license | 2026-11-16 |

## 14. Open questions

None at the moment.
