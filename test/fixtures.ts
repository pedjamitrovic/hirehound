// Synthetic profile data and canned AI answers shared by the M3 and M4 API tests.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AiRequest } from "../src/server/ai/types.ts";
import { writeFileAtomic } from "../src/server/workspace/fsx.ts";
import type { TaskInfo } from "../src/shared/schemas/api.ts";
import { eventually } from "./helpers.ts";

export const BANK = `version: 1
id_counters: { ROLE: 2, ACH: 4, SKL: 1 }
roles:
  - id: ROLE-001
    company: Acme Robotics
    title: Engineering Manager
    start: 2021-03
    end: present
    confirmed: true
    achievements:
      - id: ACH-001
        text: Grew the platform group from 4 to 14 engineers in 18 months
        metrics: [4 to 14 engineers, 18 months]
        confirmed: true
      - id: ACH-002
        text: Introduced on-call and SLOs, cutting incidents by 40%
        confirmed: true
      - id: ACH-003
        text: Moved 30 services to Kubernetes
        confirmed: true
  - id: ROLE-002
    company: Globex
    title: Senior Software Engineer
    start: 2017
    end: 2021
    confirmed: true
    achievements:
      - id: ACH-004
        text: Built the billing service in Go
        confirmed: true
skills:
  - id: SKL-001
    name: Languages
    items: [TypeScript, Go]
    confirmed: true
`;

export const BASE = `---
id: em
label: Engineering Manager
track: management
target_titles: [Engineering Manager]
headline: Engineering Manager
theme: modern
---

Engineering leader who grows platform teams. <!-- ev: ROLE-001 -->

## Experience

### Engineering Manager, Acme Robotics | 2021-03 - present <!-- ev: ROLE-001 -->

- Grew the platform group from 4 to 14 engineers in 18 months <!-- ev: ACH-001 -->
- Introduced on-call and SLOs, cutting incidents by 40% <!-- ev: ACH-002 -->

### Senior Software Engineer, Globex | 2017 - 2021 <!-- ev: ROLE-002 -->

- Built the billing service in Go <!-- ev: ACH-004 -->
`;

export const TAILORED = [
  "Engineering manager who grows platform teams and runs Kubernetes migrations. <!-- ev: ROLE-001, ACH-003 -->",
  "",
  "## Experience",
  "",
  "### Engineering Manager, Acme Robotics | 2021-03 - present <!-- ev: ROLE-001 -->",
  "",
  "- Moved 30 services to Kubernetes <!-- ev: ACH-003 -->",
  "- Grew the platform team from 4 to 14 engineers in 18 months <!-- ev: ACH-001 -->",
  "",
  "### Senior Software Engineer, Globex | 2017 - 2021 <!-- ev: ROLE-002 -->",
  "",
  "- Built the billing service in Go <!-- ev: ACH-004 -->",
].join("\n");

export const strongMatrix = [
  {
    id: "R1",
    text: "Grows engineering teams",
    weight: "must",
    source: "jd-wording",
    quote: "grow the team",
    match: "met",
    evidence: ["ACH-001"],
    note: null,
  },
  {
    id: "R2",
    text: "Kubernetes",
    weight: "strong",
    source: "jd-wording",
    quote: "Kubernetes",
    match: "met",
    evidence: ["ACH-003"],
    note: null,
  },
  {
    id: "R3",
    text: "TypeScript",
    weight: "nice",
    source: "jd-structure",
    quote: null,
    match: "partial",
    evidence: ["SKL-001"],
    note: "Listed as a skill only",
  },
];

export const weakMatrix = [
  { ...strongMatrix[0], match: "partial" },
  { ...strongMatrix[1], match: "gap", evidence: [] },
  { ...strongMatrix[2], match: "gap", evidence: [] },
];

export function evaluation(requirements: unknown[]) {
  return {
    summary: { text: "Lead the platform team.", hidden_signals: ["Hands-on Kubernetes"] },
    fit: { requirements, rationale: "Team growth is well covered." },
    level: { base: "em", rationale: "A management role." },
    compensation: {
      basis: "unknown",
      min: null,
      max: null,
      currency: null,
      period: null,
      raw: null,
      note: "Not stated.",
    },
    work_authorization: { status: "compatible", location_fit: "fits", note: "Remote in the EU." },
    legitimacy: { live: "live", repost: "unknown", ghost_signals: [], risk: "low" },
    recommendation: { verdict: "apply", reason: "Strong match on team growth." },
  };
}

/** Claims as the verify task renders them: "[n] Bullet ..., cites X\n<text>". */
export function claimsIn(req: AiRequest<unknown>): { n: number; text: string }[] {
  return [...req.input.matchAll(/^\[(\d+)\][^\n]*\n([^\n]*)$/gm)].map((m) => ({
    n: Number(m[1]),
    text: m[2] ?? "",
  }));
}

/** A verifier that supports every claim. */
export function supportAll(req: AiRequest<unknown>) {
  return {
    claims: claimsIn(req).map((c) => ({
      n: c.n,
      verdict: "supported",
      reason: "Matches the entry.",
      suggestion: null,
    })),
  };
}

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** Writes the synthetic bank, base CV, contact details and preferences into a workspace. */
export async function writeProfile(
  root: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const files: Record<string, string> = {
    "profile/experience-bank.yaml": BANK,
    "profile/bases/em.md": BASE,
    "profile/contact.yaml":
      "version: 1\nname: Alex Example\nemail: alex@example.com\nphone: '+49 30 1234567'\nlinks:\n  - label: LinkedIn\n    url: https://www.linkedin.com/in/alex-example\n",
    "profile/preferences.yaml":
      "version: 1\nlocation:\n  based_in: { country: DE }\n  timezone: Europe/Berlin\n  work_authorization: [EU]\nscoring:\n  threshold: 70\n",
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    await writeFileAtomic(join(root, ...rel.split("/")), text);
  }
}

export type Call = <T>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; data: T }>;

export function caller(baseUrl: () => string): Call {
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl()), {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const data = res.status === 204 ? undefined : ((await res.json()) as T);
    return { status: res.status, data: data as T };
  };
}

/** Starts a background task through the API and waits for it to finish. */
export async function runApiTask(
  call: Call,
  method: string,
  path: string,
  body?: unknown,
): Promise<TaskInfo> {
  const started = await call<TaskInfo>(method, path, body);
  if (started.status !== 202) throw new Error(`expected 202, got ${JSON.stringify(started)}`);
  let task: TaskInfo | undefined;
  await eventually(async () => {
    task = (await call<TaskInfo>("GET", `/api/tasks/${started.data.id}`)).data;
    return task.state !== "running";
  }, 15_000);
  if (!task) throw new Error("task vanished");
  return task;
}
