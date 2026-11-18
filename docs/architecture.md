# Architecture

Hirehound is a single npm package: a small Node.js server and a Preact single-page app, talking
JSON over HTTP and Server-Sent Events. Requirements are in `docs/PRD.md` (section 8); conventions
for working on the code are in `CLAUDE.md`.

## Repository layout

```
bin/hirehound.ts             CLI entry (serve, init)
src/shared/                  isomorphic: Zod schemas, state machine, score, slugs, frontmatter
  schemas/                   workspace file schemas + HTTP API contract (api.ts)
  cv/                        CV dialect parser and serializer (M2)
src/server/
  cli.ts  server.ts          argument parsing, HTTP server lifecycle
  config.ts                  workspace resolution and ~/.config/hirehound/config.yaml
  http/                      router, Host/Origin guard, SSE hub, static files
  routes/                    one module per resource
  workspace/                 init, atomic file IO, YAML diagnostics, index, watcher, git check
  jobs/                      job creation, posting snapshot and extraction, transitions (M1);
                             evaluate, tailor, verify tasks and the review/approve flow (M3)
  ai/                        engine adapter (Anthropic API, Claude Code), runTask, prompts/
  onboarding/                AI task definitions and the onboarding flow
  profile/                   profile files, experience bank ops, base CVs, imports
  import/                    ZIP, DOCX and LinkedIn export readers (no dependencies)
  pdf/                       CV HTML document, themes, static Inter (@fontsource/inter), rendering
                             via playwright-core, PDF text read-back
  tasks.ts                   background tasks with progress over SSE
src/web/
  main.tsx  app.tsx          bootstrap and screen switch
  router.ts  hotkeys.ts      history router, keyboard layer
  state/                     signals: jobs index, workspace info, toasts, theme
  components/  screens/      UI
  styles/                    tokens.css (light-dark colors), base, components, screens
test/                        cross-module tests (HTTP API) and helpers
docs/                        PRD, data contract, CV dialect, UX, this file
```

## Runtime

- **Node.js 24+** runs the server's TypeScript directly through native type stripping. There is no
  server build. Native stripping does not apply inside `node_modules`, so the npm package (M7)
  will ship `tsc`-emitted JavaScript produced at publish time.
- **HTTP:** `node:http` with a ~150-line router. JSON in and out, typed by `src/shared/schemas/api.ts`.
  `/api/events` is an SSE stream: `job-upsert`, `job-remove` and `workspace` events, later task
  progress.
- **Development:** `npm run dev` runs the server under `node --watch` and mounts Vite in middleware
  mode on the same port, so there is one origin and no proxy.
- **Production:** `npm run build` bundles `src/web` into `dist/web`; the server serves it with a
  strict Content-Security-Policy.

## Files, index and live sync

There is no database. At startup the server reads the workspace into an in-memory index
(`WorkspaceIndex`): job summaries, profile file states and diagnostics. A recursive `fs.watch`
reports changes; events are debounced per job folder and the folder is re-read. Reloads are
idempotent, which makes duplicate or missing watcher events harmless, and the index only emits an
event when what the UI shows has changed. If native watching fails (for example when Linux runs
out of inotify watches), the watcher falls back to polling and Settings says so.

All writes go through `writeFileAtomic` (temp file + rename, with retries for transient Windows
locks). The UI applies the server's response immediately and also receives the change over SSE,
so edits from an editor or Claude Code show up the same way as edits from the app.

## Security model

The server can read and write personal files, so:

- it binds to `127.0.0.1` only;
- it accepts only `Host` headers for its own port on `127.0.0.1`, `localhost` or `[::1]`
  (DNS-rebinding protection);
- it rejects cross-origin requests by `Origin` and `Sec-Fetch-Site`, and accepts JSON bodies only;
- fetched posting HTML is served with `Content-Security-Policy: sandbox` and never rendered in the
  app's origin;
- API keys are read from the environment or a user-only config file outside the workspace (M2) and
  are never written into the workspace.

## Evaluate, tailor, verify, approve (M3)

`src/server/jobs/flow.ts` (`JobFlow`) runs the hero flow for one job; each AI step is a background
task, one per job at a time, and the task runner works on at most three tasks at once.

1. **Evaluate** (`evaluate` task): posting + preferences + confirmed bank + base CV list in; blocks
   A-G out. `postCheck` rejects unknown or unconfirmed evidence ids, a `jd-wording` requirement
   without its quote and a base id that does not exist. Code computes the score
   (`src/shared/score.ts`) and writes `evaluation.md`.
2. **Tailor** (`tailor` task): posting, the evaluation's requirements, the base CV and the confirmed
   bank in; a CV body plus reasons out. `postCheck` runs the dialect parser and the deterministic
   checks, so the model gets one repair round with the exact problems. The task is lenient: a CV that
   still fails is written anyway, and the checks then block it in the review where the user can fix it.
3. **Check** (no model unless claims changed): `src/shared/cv/checks.ts` runs the deterministic
   checks; claims whose key (text plus cited evidence) has no verdict yet go to the `verify` task,
   which sees only claims and their cited entries; the PDF is rendered and read back with
   `src/server/pdf/text.ts` (a small reader for Chrome's PDFs: objects, Flate streams, ToUnicode
   maps, Tj/TJ) for the ATS round trip. Everything lands in `verification.json`, and the job moves
   between `tailoring` and `ready` to match guard G1.
4. **Approve**: the review recomputes everything from the files, refuses when anything blocks, asks
   for a reason below the score threshold, and `JobService.approve` re-checks G2 inside the job's lock
   before recording the PDF's SHA-256.

The review screen (`src/web/screens/job/CvTab.tsx`) works from `GET /api/jobs/:id/cv`, which
returns the CV as rows (sections, claims with diff state, verdicts, check issues, removed base
claims), the evidence for chips, the render and the list of blockers.

## AI engine adapter

Implemented in M2 as designed below, with these specifics: the API engine streams, sends
`output_config.format` with a JSON Schema derived from the task's Zod schema (unsupported keywords
stripped; Zod enforces them afterwards) and opts into server-side refusal fallback. The Claude Code
engine does not use `--bare` (bare mode cannot use a Claude Code login); instead it runs in an empty
temporary folder with `--tools ""` (or only `Read` for attached PDFs) and `--no-session-persistence`,
so no project settings, hooks or files are involved. `runTask` makes one repair attempt when the
output fails the schema or the task's deterministic checks, and appends usage to `ai-log.jsonl`.

### Original design

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
