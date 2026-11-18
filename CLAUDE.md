# Hirehound: conventions for contributors and Claude

Hirehound is a local-first, web-based, Claude-powered job search workbench. Requirements live in
`docs/PRD.md`; the decisions in its section 13 are settled. Read `docs/data-contract.md` before
touching workspace files and `docs/cv-dialect.md` before touching CV parsing.

## Commands

```bash
npm install
npm run dev        # server + Vite middleware on one port, live reload; no browser auto-open
npm run build      # bundle the web UI into dist/web
npm start          # production mode: serves dist/web
npm run check      # lint + typecheck + tests (what CI runs, plus build)
npm test           # node:test, all src/**/*.test.ts and test/**/*.test.ts
npm run format     # Biome format + safe fixes
```

Run against a throwaway workspace while developing: `node bin/hirehound.ts --workspace <tmp>`.

## Non-negotiables

- **No personal data in this repo.** It is public. User data lives only in a workspace folder
  outside the repo. Never add real CVs, postings or contact details as fixtures; write synthetic ones.
- **Truthfulness.** Every CV claim traces to an experience-bank entry. Deterministic checks and the
  faithfulness verifier are blocking; never add a path around them.
- **Approval is locked to the SHA-256 of the exact PDF.** Applying refuses a changed PDF.
- **The app always stops before Submit.** Never auto-submit, never bypass anti-bot measures.

## Architecture in one screen

- Node.js 24+ runs the TypeScript in `src/server`, `src/shared` and `bin` directly (native type
  stripping, no build). Vite bundles only `src/web`.
- `node:http` + `src/server/http/router.ts`. Server-Sent Events (`/api/events`) push index changes
  to every open tab. The server binds to 127.0.0.1 only and checks Host/Origin (`http/guard.ts`).
- **Files are the source of truth.** No database. `workspace/index.ts` is an in-memory cache built
  from files at startup and kept current by `workspace/watcher.ts` (recursive `fs.watch`, polling
  fallback). Anything can edit the workspace (the app, an editor, Claude Code); the UI follows.
- `src/shared` is isomorphic (no `node:*` imports, no DOM): Zod schemas, the state machine, the
  score function, slugs, frontmatter. Server and web import it.
- Web: Preact + `@preact/signals`, a ~100-line router (`src/web/router.ts`), plain CSS with
  custom properties and nesting (`src/web/styles`). No component or state library. Never import a
  Zod schema as a value in web code (it pulls Zod into the bundle): `import type`, or plain lists
  from `src/shared/enums.ts`.
- AI: every LLM call is a task in `src/server/onboarding/tasks.ts` style (`TaskDef`: prompt file in
  `src/server/ai/prompts/<name>.md`, Zod output schema, deterministic `postCheck`), run with
  `runTask` through the engine adapter (`src/server/ai`). Long work runs in the background via
  `TaskRunner` with progress over SSE. Tests use `FakeEngine`; nothing in tests calls the network.
- The experience bank (`profile/experience-bank.yaml`) is edited only through `applyBankOps` /
  `appendEntries` (`src/server/profile/bank-ops.ts`): ids are allocated there and never reused.
- PDFs: `src/server/pdf` renders the CV HTML with the installed Chrome or Edge via
  `playwright-core` (no browser download). Themes are CSS in `src/server/pdf/themes`; the font is
  static Inter from `@fontsource/inter` (SIL OFL), inlined into each document. Use static fonts
  only: Chrome embeds variable fonts as Type3 glyphs, which ATS read poorly.

## TypeScript rules (native type stripping)

- Erasable syntax only: no `enum`, `namespace`, parameter properties or `import =`. Use `as const`
  objects and string unions. Classes assign fields explicitly; prefer `#private` fields.
- Relative imports include the extension: `import { x } from "./x.ts"`.
- Type-only imports use `import type` (enforced by `verbatimModuleSyntax`).
- TypeScript 7 defaults `types` to `[]`; the server config lists `node`, the web config `vite/client`.
- `noUncheckedIndexedAccess` is on: handle `undefined` from indexing instead of asserting.

## Dependencies

Runtime dependencies are limited to `preact`, `@preact/signals`, `zod`, `yaml`, `playwright-core`
and `@fontsource/inter` (font files only, no code; added in M4 at the maintainer's request). Dev
dependencies: `typescript`, `vite`, `@biomejs/biome`, `@types/node`.
**Ask the maintainer before adding any other dependency**, with a justification. Prefer Node
built-ins and the web platform.

## Workspace files

- Every YAML file has `version: 1`. Schemas live in `src/shared/schemas`. Document any change in
  `docs/data-contract.md` in the same commit.
- Read files with `readTextFile` (strips BOM, normalises CRLF). Write with `writeFileAtomic`
  (temp file + rename, retries transient Windows locks, always LF).
- Parse YAML with `parseYaml` (line-numbered diagnostics, unknown keys become warnings). A broken
  file must never crash the server: report it and keep going.
- Timestamps are local time with offset (`localIsoDateTime()`), dates are `YYYY-MM-DD`.
- When the app edits a user-owned YAML file, preserve comments and key order (yaml Document API).
- Job folder ids: `<YYYY-MM-DD>_<company slug>_<role slug>[-n]` via `jobIdFor`. Never rename
  a job folder after creation; the id is permanent.

## Cross-platform

The maintainer develops on Windows; CI runs Windows and Linux. Always use `node:path` (`join`,
`resolve`, `relative`), never string concatenation with `/`. Show workspace paths in the UI and
diagnostics with forward slashes (`toWorkspacePath`). Expect `fs.watch` to deliver duplicate,
missing or null filenames: reloads must be idempotent. The repo is LF-only (`.gitattributes`).

## Code style

- Small, boring, well-tested code. Pure functions in `src/shared` with unit tests next to them
  (`*.test.ts`). Server integration tests start a real server on port 0 with a temp workspace
  (`test/helpers.ts`).
- Biome formats and lints (`npm run format`). It does not touch Markdown.
- Never use em dashes, en dashes or curly quotes in code, comments, strings or UI copy. Use `-`
  and straight quotes.
- UI copy is short, calm and specific. Placeholder screens say which milestone fills them.
- Check current docs (Anthropic Messages API, Claude Code headless, Playwright, Preact, Node)
  instead of guessing APIs; several of these move fast.

## UX conventions

- Keyboard first: register shortcuts with `useHotkeys` (they appear in the `?` sheet). Global:
  `/` search, `?` shortcuts, `g t`/`g p`/`g s` navigation.
- Colors only through tokens in `styles/tokens.css` (`light-dark()` handles dark mode).
- Every state change that the server confirms comes back through SSE; the client may apply the
  response optimistically but the server is the authority.
- No dead ends: every AI output is editable, every blocked action says why.

## Git

- One GitHub issue per milestone, a branch per milestone (`m<N>-<topic>`), a PR per milestone.
- Commit messages reference the issue, e.g. `feat: pipeline board (#2)`.
- Keep `PR_DESCRIPTION.md` out of commits; it is a local scratch file for PR bodies.
