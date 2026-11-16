import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AT, sampleStatus, tempWorkspace, writeJob } from "../../../test/helpers.ts";
import type { ServerEvent } from "../../shared/schemas/api.ts";
import { WorkspaceIndex } from "./index.ts";

const ID = "2026-11-16_acme_engineering-manager";

describe("WorkspaceIndex", () => {
  it("starts empty for a fresh workspace with profile files not set up", async () => {
    const ws = await tempWorkspace();
    try {
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const info = index.info();
      assert.equal(info.jobCount, 0);
      assert.deepEqual(index.list(), []);
      assert.equal(info.profile.contact, "missing");
      assert.equal(info.profile.preferences, "missing");
      assert.equal(info.profile.answers, "ok");
      assert.deepEqual(
        info.diagnostics.filter((d) => d.file !== "."),
        [],
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("loads valid jobs into summaries", async () => {
    const ws = await tempWorkspace();
    try {
      await writeJob(ws.root, ID, {
        status: sampleStatus({
          state: "evaluated",
          history: [
            { at: AT, from: null, to: "found", by: "user" },
            { at: "2026-11-17T09:00:00+01:00", from: "found", to: "evaluated", by: "user" },
          ],
        }),
      });
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const [job] = index.list();
      assert.equal(job?.id, ID);
      assert.equal(job?.company, "Acme");
      assert.equal(job?.state, "evaluated");
      assert.equal(job?.addedAt, AT);
      assert.equal(job?.updatedAt, "2026-11-17T09:00:00+01:00");
      assert.equal(job?.errors, 0);
      assert.deepEqual(index.get(ID)?.files, ["posting.md", "status.yaml"]);
    } finally {
      await ws.cleanup();
    }
  });

  it("keeps broken jobs visible with diagnostics", async () => {
    const ws = await tempWorkspace();
    try {
      await writeJob(ws.root, "2026-11-16_globex_staff-engineer", {
        posting: null,
        status: "state: nonsense\n",
      });
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const record = index.get("2026-11-16_globex_staff-engineer");
      assert.ok(record);
      assert.equal(record.summary.company, "Globex");
      assert.equal(record.summary.title, "Staff Engineer");
      assert.equal(record.summary.state, "found");
      assert.ok(record.summary.errors >= 2);
      const files = record.diagnostics.map((d) => d.file);
      assert.ok(files.includes("jobs/2026-11-16_globex_staff-engineer/posting.md"));
      assert.ok(files.includes("jobs/2026-11-16_globex_staff-engineer/status.yaml"));
    } finally {
      await ws.cleanup();
    }
  });

  it("warns when state and history disagree", async () => {
    const ws = await tempWorkspace();
    try {
      await writeJob(ws.root, ID, { status: sampleStatus({ state: "applied" }) });
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const warning = index.get(ID)?.diagnostics.find((d) => d.severity === "warning");
      assert.match(warning?.message ?? "", /last history entry/);
      assert.equal(index.get(ID)?.summary.state, "applied");
    } finally {
      await ws.cleanup();
    }
  });

  it("ignores folders that do not follow the naming rule", async () => {
    const ws = await tempWorkspace();
    try {
      await mkdir(join(ws.root, "jobs", "My Notes"));
      await mkdir(join(ws.root, "jobs", ".cache"));
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      assert.equal(index.list().length, 0);
      const diag = index.info().diagnostics.find((d) => d.file === "jobs/My Notes");
      assert.equal(diag?.severity, "warning");
      assert.equal(
        index.info().diagnostics.some((d) => d.file.includes(".cache")),
        false,
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("reports profile file problems", async () => {
    const ws = await tempWorkspace();
    try {
      await writeFile(join(ws.root, "profile", "contact.yaml"), "name: Alex\nemail: nope\n");
      await writeFile(join(ws.root, "profile", "bases", "em.md"), "# EM\n");
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const info = index.info();
      assert.equal(info.profile.contact, "invalid");
      assert.deepEqual(info.profile.bases, ["em"]);
      assert.ok(info.diagnostics.some((d) => d.file === "profile/contact.yaml"));
    } finally {
      await ws.cleanup();
    }
  });

  it("emits upserts and removals only when something changed", async () => {
    const ws = await tempWorkspace();
    try {
      const index = new WorkspaceIndex(ws.root);
      await index.load();
      const events: ServerEvent[] = [];
      index.subscribe((e) => events.push(e));

      await writeJob(ws.root, ID);
      await index.reloadJob(ID);
      assert.deepEqual(
        events.map((e) => e.type),
        ["job-upsert", "workspace"],
      );

      events.length = 0;
      await index.reloadJob(ID);
      assert.equal(events.length, 0, "an unchanged job emits nothing");

      await rm(join(ws.root, "jobs", ID), { recursive: true });
      await index.rescan();
      assert.deepEqual(
        events.map((e) => e.type),
        ["job-remove", "workspace"],
      );
    } finally {
      await ws.cleanup();
    }
  });
});
