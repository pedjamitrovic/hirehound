import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeEngine } from "../src/server/ai/fake.ts";
import { type RunningServer, startServer } from "../src/server/server.ts";
import type {
  BaseDetail,
  BaseSummary,
  ImportInfo,
  ProfileFile,
  TaskInfo,
} from "../src/shared/schemas/api.ts";
import type { BankFile } from "../src/shared/schemas/bank.ts";
import type { OnboardingFile } from "../src/shared/schemas/onboarding.ts";
import { eventually, tempDir, tempWorkspace } from "./helpers.ts";

const CV = `# Alex Example
Engineering Manager at Acme Robotics, 2021-03 to present, Berlin.
- Grew the platform group from 4 to 14 engineers in 18 months
- Introduced on-call and SLOs
Skills: TypeScript, Go`;

/** Canned AI answers that behave like a careful model would. */
function engine(): FakeEngine {
  return new FakeEngine({
    "draft-bank": (req) => {
      const source =
        /Source files \(use these exact names in "source"\): ([^\n]+)/.exec(req.input)?.[1] ?? "";
      return {
        contact: { name: "Alex Example", email: null, phone: null, location: "Berlin", links: [] },
        roles: [
          {
            ref: "acme-em",
            company: "Acme Robotics",
            title: "Engineering Manager",
            start: "2021-03",
            end: "present",
            location: "Berlin",
            employment_type: null,
            summary: null,
            source,
            achievements: [
              {
                ref: "acme-growth",
                text: "Grew the platform group from 4 to 14 engineers in 18 months",
                detail: null,
                metrics: ["4 to 14 engineers", "18 months"],
                skills: ["hiring"],
                source,
              },
              {
                ref: "acme-oncall",
                text: "Introduced on-call and SLOs",
                detail: null,
                metrics: [],
                skills: [],
                source,
              },
            ],
          },
        ],
        projects: [],
        education: [],
        certifications: [],
        skills: [{ ref: "skills-lang", name: "Languages", items: ["TypeScript", "Go"], source }],
        languages: [],
        awards: [],
        questions: [
          {
            about: "acme-oncall",
            question: "What changed after on-call was introduced?",
            why: "A result makes it stronger.",
          },
        ],
      };
    },
    "apply-answers": () => ({
      changes: [
        { id: "ACH-002", field: "metrics", value: ["40% fewer incidents"], question: "Q-001" },
        {
          id: "ACH-002",
          field: "text",
          value: "Introduced on-call and SLOs, cutting incidents by 40%",
          question: "Q-001",
        },
      ],
      additions: [],
      unused: [],
    }),
    "draft-base": () => ({
      headline: "Engineering Manager, Platform",
      body: [
        "## Experience",
        "",
        "### Engineering Manager, Acme Robotics | 2021-03 - present <!-- ev: ROLE-001 -->",
        "",
        "- Grew the platform group from 4 to 14 engineers in 18 months <!-- ev: ACH-001 -->",
        "- Introduced on-call and SLOs, cutting incidents by 40% <!-- ev: ACH-002 -->",
        "",
        "## Skills",
        "",
        "- **Languages:** TypeScript, Go <!-- ev: SKL-001 -->",
      ].join("\n"),
      notes: "Led with team growth.",
    }),
  });
}

describe("Onboarding API", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let config: Awaited<ReturnType<typeof tempDir>>;
  let server: RunningServer;
  const fake = engine();

  before(async () => {
    ws = await tempWorkspace();
    config = await tempDir();
    server = await startServer({
      workspace: ws.root,
      configDir: config.path,
      port: 0,
      log: () => {},
      aiEngine: fake,
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
    await config.cleanup();
  });

  const call = async <T>(method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(new URL(path, server.url), {
      method,
      headers: raw
        ? { "content-type": "application/octet-stream" }
        : body === undefined
          ? {}
          : { "content-type": "application/json" },
      body: raw ?? (body === undefined ? null : JSON.stringify(body)),
    });
    const data = res.status === 204 ? undefined : ((await res.json()) as T);
    return { status: res.status, data: data as T };
  };

  const waitForTask = async (id: string): Promise<TaskInfo> => {
    let task: TaskInfo | undefined;
    await eventually(async () => {
      task = (await call<TaskInfo>("GET", `/api/tasks/${id}`)).data;
      return task.state !== "running";
    }, 10_000);
    if (!task) throw new Error("task vanished");
    if (task.state === "failed") throw new Error(`task failed: ${task.error}`);
    return task;
  };

  it("imports a file and drafts unconfirmed bank entries with questions", async () => {
    const upload = await call<ImportInfo>(
      "POST",
      "/api/profile/imports?name=My%20CV.md",
      undefined,
      CV,
    );
    assert.equal(upload.status, 201);
    assert.match(upload.data.name, /^\d{4}-\d{2}-\d{2}_my-cv\.md$/);
    assert.equal(upload.data.kind, "text");

    const bad = await call<{ error: { code: string } }>(
      "POST",
      "/api/profile/imports?name=old.doc",
      undefined,
      "x",
    );
    assert.equal(bad.status, 400);

    const started = await call<TaskInfo>("POST", "/api/onboarding/draft", {});
    assert.equal(started.status, 202);
    const done = await waitForTask(started.data.id);
    assert.deepEqual(done.result, { entries: 4, questions: 1 });
    assert.ok((done.usage?.inputTokens ?? 0) > 0);

    const bank = (await call<ProfileFile<BankFile>>("GET", "/api/profile/bank")).data;
    const role = bank.value?.roles[0];
    assert.equal(role?.id, "ROLE-001");
    assert.equal(role?.confirmed, false);
    assert.equal(role?.source, `imports/${upload.data.name}`);
    assert.deepEqual(
      role?.achievements.map((a) => a.id),
      ["ACH-001", "ACH-002"],
    );

    const onboarding = (await call<OnboardingFile>("GET", "/api/onboarding")).data;
    assert.equal(onboarding.questions[0]?.entry, "ACH-002");
    assert.equal(onboarding.contact_suggestion?.name, "Alex Example");

    const log = await readFile(join(ws.root, "ai-log.jsonl"), "utf8");
    assert.match(log, /"task":"draft-bank"/);
  });

  it("turns answers into reviewed edits", async () => {
    await call("PUT", "/api/onboarding/answers", {
      answers: [{ id: "Q-001", answer: "Incidents dropped by 40%" }],
    });
    const started = await call<TaskInfo>("POST", "/api/onboarding/answers/propose");
    const done = await waitForTask(started.data.id);
    const proposal = done.result as {
      ops: unknown[];
      changes: { id: string; after: Record<string, unknown> }[];
      bankSha256: string;
      questionIds: string[];
    };
    assert.equal(proposal.changes.length, 1);
    assert.equal(
      proposal.changes[0]?.after.text,
      "Introduced on-call and SLOs, cutting incidents by 40%",
    );

    const applied = await call<ProfileFile<BankFile>>("POST", "/api/profile/bank/ops", {
      ops: proposal.ops,
      expectedSha256: proposal.bankSha256,
    });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.data.value?.roles[0]?.achievements[1]?.metrics, [
      "40% fewer incidents",
    ]);

    const stale = await call<{ error: { code: string } }>("POST", "/api/profile/bank/ops", {
      ops: proposal.ops,
      expectedSha256: proposal.bankSha256,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, "changed-on-disk");
  });

  it("refuses to write a base CV before anything is confirmed, then writes one", async () => {
    const refused = await call<TaskInfo>("POST", "/api/profile/bases/draft", {
      label: "Engineering Manager",
      track: "management",
    });
    const failed = (
      await eventually(async () => {
        const t = (await call<TaskInfo>("GET", `/api/tasks/${refused.data.id}`)).data;
        return t.state !== "running";
      }).then(() => call<TaskInfo>("GET", `/api/tasks/${refused.data.id}`))
    ).data;
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /Confirm some experience bank entries/);

    const bank = (await call<ProfileFile<BankFile>>("GET", "/api/profile/bank")).data;
    const confirmed = await call<ProfileFile<BankFile>>("POST", "/api/profile/bank/ops", {
      ops: [{ op: "confirm", ids: ["ROLE-001", "ACH-001", "ACH-002", "SKL-001"], confirmed: true }],
      expectedSha256: bank.sha256,
    });
    assert.equal(confirmed.status, 200);

    const started = await call<TaskInfo>("POST", "/api/profile/bases/draft", {
      label: "Engineering Manager",
      track: "management",
      target_titles: ["Engineering Manager"],
    });
    const done = await waitForTask(started.data.id);
    assert.equal((done.result as { id: string }).id, "engineering-manager");

    const list = (await call<BaseSummary[]>("GET", "/api/profile/bases")).data;
    assert.deepEqual(
      list.map((b) => [b.id, b.errors, b.warnings]),
      [["engineering-manager", 0, 0]],
    );
    const detail = (await call<BaseDetail>("GET", "/api/profile/bases/engineering-manager")).data;
    assert.equal(detail.summary.headline, "Engineering Manager, Platform");
    assert.deepEqual(
      detail.evidence.map((e) => e.id),
      ["ROLE-001", "ACH-001", "ACH-002", "SKL-001"],
    );

    const preview = await fetch(
      new URL("/api/profile/bases/engineering-manager/preview", server.url),
    );
    assert.match(preview.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await preview.text();
    assert.match(html, /Engineering Manager, Platform/);
    assert.doesNotMatch(html, /ev:/);
  });

  it("renders the base CV to PDF with the installed browser", async (t) => {
    const status = (await call<{ ok: boolean; detail: string }>("GET", "/api/settings/pdf")).data;
    if (!status.ok) {
      t.skip(`no Chrome or Edge here: ${status.detail}`);
      return;
    }
    const res = await fetch(new URL("/api/profile/bases/engineering-manager/pdf", server.url));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("x-pdf-pages"), "1");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  });

  it("keeps AI settings outside the workspace and never returns the key", async () => {
    const saved = await call<{ apiKey: { present: boolean; source: string } }>(
      "PUT",
      "/api/settings/ai/key",
      {
        key: "sk-ant-test-key",
      },
    );
    assert.deepEqual(saved.data.apiKey, { present: true, source: "file" });
    assert.doesNotMatch(JSON.stringify(saved.data), /sk-ant/);
    const credentials = await readFile(join(config.path, "credentials.yaml"), "utf8");
    assert.match(credentials, /sk-ant-test-key/);
    const updated = await call<{ engine: string; model: string }>("PUT", "/api/settings/ai", {
      model: "claude-sonnet-5-5",
    });
    assert.equal(updated.data.model, "claude-sonnet-5-5");
  });
});
