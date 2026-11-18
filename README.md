# Hirehound

🐕 Hirehound: a local-first web app that sniffs out the right jobs and tailors your CV for each one, using only what you've actually done. Every claim is linked to your real experience, you approve every application, and you always press Submit. Powered by Claude.

> **Status: early development.** Working today: the job pipeline (add jobs by link or text, Kanban and table, job dossier), onboarding (import your CVs, Claude drafts an evidence-linked experience bank you review, base CVs with PDF preview), and the hero flow: evaluate a posting, tailor a CV from a base, blocking deterministic checks and a faithfulness verifier, side-by-side review and approval locked to the PDF's SHA-256. Applying and cover letters arrive in M4. See [the PRD](docs/PRD.md) for the full plan.

## Why

Tailoring every CV by hand is slow, and weeks later you can't remember what you sent or what the (since deleted) ad said. LLMs tailor well, but naive use invents experience you can't defend in an interview. Hirehound is built around three rules:

- **Tailor without lying.** Every line of a tailored CV links to an entry in your experience bank. Deterministic checks (numbers, dates, titles, companies) and a separate faithfulness verifier must pass before a CV can be approved.
- **You stay in control.** Your approval is locked to the SHA-256 of the exact PDF. Hirehound fills forms at most; it always stops before Submit.
- **A permanent record.** Each job keeps the posting snapshot, the evaluation, the exact CV you sent and a timeline, ready for the moment a recruiter calls.

It is web-first: comparing jobs, reviewing a CV diff and editing your experience bank are visual tasks, so the browser UI is the primary interface. Apply better to fewer.

## Features (planned)

| Area | What it does | Milestone |
|---|---|---|
| Pipeline | Add jobs by URL or text, Kanban board and dense table, job dossier, state machine | M1 |
| Profile | Import existing CVs (.md, .txt, .pdf, .docx, LinkedIn export), experience bank, multiple base CVs | M2 |
| Evaluate | Role summary, weighted requirement matrix with evidence, fit score, comp, work authorisation, legitimacy | M3 |
| Tailor and verify | Evidence-linked tailoring, blocking checks and verifier, side-by-side review, PDF export with an ATS read-back check, approval locked to the PDF | M3 |
| Apply | Manual checklist or assisted form filling in a visible browser, reusable answers, optional cover letter | M4 |
| Discover | Greenhouse, Lever and Ashby boards, LinkedIn alert import, dedupe, liveness, scheduled scans | M5 |
| Follow up | Follow-up reminders, reply classification, interview prep and debriefs, funnel insights | M6 |

## Getting started

Requirements: [Node.js](https://nodejs.org) 24 or newer (26 LTS recommended) and git.

```bash
git clone https://github.com/pedjamitrovic/hirehound.git
cd hirehound
npm install
npm run build
npm start
```

Hirehound opens in your browser at `http://127.0.0.1:4280`. On first start it creates a workspace at `~/Documents/hirehound`. To use another folder:

```bash
npm start -- --workspace ~/jobs-workspace
```

or set `HIREHOUND_WORKSPACE`, or put `workspace: ~/jobs-workspace` in `~/.config/hirehound/config.yaml`. `npm run init -- <path>` creates a workspace without starting the app. (A one-command `npx hirehound` install arrives in M7.)

### Connecting Claude

Onboarding and (later) evaluation and tailoring use Claude. In **Settings, AI engine**, choose one:

- **Anthropic API**: set `ANTHROPIC_API_KEY`, or paste a key in Settings (it is stored in `~/.config/hirehound/credentials.yaml`, readable only by your user, never in the workspace).
- **Claude Code**: uses your existing Claude Code login, if the `claude` command is installed.

The default model is Claude Opus 5.5; each AI task's token use and estimated cost is logged to `ai-log.jsonl` in your workspace. PDFs are rendered by the Google Chrome or Microsoft Edge already installed on your computer.

### Your data

Everything lives as plain Markdown and YAML in your workspace folder: profile, base CVs, one folder per job with the posting snapshot, evaluation, tailored CV and status history. The format is documented in [docs/data-contract.md](docs/data-contract.md). You can edit the files by hand or with Claude Code and the app updates live. Back the folder up with git, using a **private** repository; Hirehound warns you if the workspace sits in a repository with a remote.

Hirehound has no account, no telemetry and no backend of its own. The server listens on 127.0.0.1 only. Your CV data goes only to the AI provider you configure.

## Development

```bash
npm run dev     # server + live-reloading UI on http://127.0.0.1:4280
npm run check   # lint, typecheck and tests
```

Conventions are in [CLAUDE.md](CLAUDE.md). The stack is deliberately small: Node's native TypeScript support, `node:http`, Preact with signals, plain CSS, Zod and yaml. See [docs/architecture.md](docs/architecture.md).

## Credits

Hirehound stands on the shoulders of [career-ops](https://github.com/career-ops-hq/career-ops) (MIT), the most complete open-source AI job search pipeline we know of. Several of its ideas shape Hirehound: multi-block evaluation, weighted requirements labelled by evidence source, legitimacy and ghost-job checks, the score guardrail, the anti-fabrication checks, the STAR+R story bank, files as the canonical store with a documented data contract, and editable prompts. Hirehound is a separate project with its own code; it differs mainly in being web-first, in linking every tailored claim to evidence with a blocking faithfulness verifier, in supporting multiple base profiles, and in locking approval to the exact PDF.

The CV themes use the [Inter](https://rsms.me/inter/) typeface by The Inter Project Authors, bundled under the SIL Open Font License 1.1 (see `src/server/pdf/fonts/OFL.txt`).

## License

[MIT](LICENSE)
