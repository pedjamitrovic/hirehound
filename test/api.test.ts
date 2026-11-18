import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { type RunningServer, startServer } from "../src/server/server.ts";
import type {
  ApiErrorBody,
  JobDetail,
  JobSummary,
  ServerEvent,
  WorkspaceInfo,
} from "../src/shared/schemas/api.ts";
import { eventually, sampleStatus, tempWorkspace, writeJob } from "./helpers.ts";

const ID = "2026-11-16_acme_engineering-manager";

describe("HTTP API", () => {
  let ws: Awaited<ReturnType<typeof tempWorkspace>>;
  let server: RunningServer;

  before(async () => {
    ws = await tempWorkspace();
    await writeJob(ws.root, ID);
    server = await startServer({
      workspace: ws.root,
      port: 0,
      log: () => {},
      watch: { debounceMs: 20 },
    });
  });

  after(async () => {
    await server.close();
    await ws.cleanup();
  });

  const api = (path: string, init?: RequestInit) => fetch(new URL(path, server.url), init);

  it("serves health and workspace info", async () => {
    const health = await api("/api/health");
    assert.equal(health.status, 200);
    const info = (await (await api("/api/workspace")).json()) as WorkspaceInfo;
    assert.equal(info.path, ws.root);
    assert.equal(info.jobCount, 1);
  });

  it("lists jobs and returns details", async () => {
    const jobs = (await (await api("/api/jobs")).json()) as JobSummary[];
    assert.deepEqual(
      jobs.map((j) => j.id),
      [ID],
    );
    const detail = (await (await api(`/api/jobs/${ID}`)).json()) as JobDetail;
    assert.equal(detail.summary.company, "Acme");
    assert.ok(detail.transitions.some((t) => t.to === "evaluated"));
  });

  it("returns JSON errors for unknown jobs and routes", async () => {
    const missing = await api("/api/jobs/2026-01-01_nope_nope");
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as ApiErrorBody).error.code, "job-not-found");
    const unknown = await api("/api/nothing-here");
    assert.equal(unknown.status, 404);
    const wrongMethod = await api("/api/jobs", { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
  });

  it("rejects requests for a foreign Host", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/health",
          headers: { host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("serves the app shell for client-side routes", async () => {
    const res = await api("/pipeline");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    await res.body?.cancel();
  });

  it("streams index changes over SSE", async () => {
    const controller = new AbortController();
    const res = await api("/api/events", { signal: controller.signal });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const events: ServerEvent[] = [];
    let buffer = "";
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = chunk
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) events.push(JSON.parse(data) as ServerEvent);
          end = buffer.indexOf("\n\n");
        }
      }
    })().catch(() => {});

    try {
      await eventually(() => events.some((e) => e.type === "hello"));
      // An outside edit (editor, Claude Code) must reach the UI through the watcher.
      await writeJob(ws.root, ID, { status: sampleStatus({ tags: ["remote-eu"] }) });
      await eventually(() =>
        events.some((e) => e.type === "job-upsert" && e.job.tags.includes("remote-eu")),
      );
    } finally {
      controller.abort();
      await pump;
    }
  });
});
