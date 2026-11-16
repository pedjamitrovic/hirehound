import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { tempWorkspace } from "../../../test/helpers.ts";
import { splitFrontmatter } from "../../shared/frontmatter.ts";
import { localIsoDate } from "../../shared/time.ts";
import type { HttpError } from "../http/router.ts";
import { WorkspaceIndex } from "../workspace/index.ts";
import { JobService } from "./service.ts";
import type { Snapshot } from "./snapshot.ts";

async function setup() {
  const ws = await tempWorkspace();
  const index = new WorkspaceIndex(ws.root);
  await index.load();
  return { ...ws, index, service: new JobService({ root: ws.root, index }) };
}

const textJob = {
  kind: "text" as const,
  company: "Acme Corp",
  title: "Engineering Manager",
  text: "About the role\r\n\r\n\r\nLead the platform team.  ",
  workplace: "remote" as const,
  employmentType: "full-time" as const,
};

function snapshot(): Snapshot {
  return {
    url: "https://jobs.example.com/x",
    finalUrl: "https://jobs.example.com/acme/1",
    fetchedAt: "2026-11-16T10:00:00+01:00",
    html: "<html><body><p>raw</p></body></html>",
    text: "## Role\n\nBuild things.",
    warnings: [],
    extracted: {
      title: "Ignored",
      company: "Ignored",
      location: "Berlin",
      workplace: "hybrid",
      employmentType: "full-time",
      salary: { min: 90000, max: 110000, currency: "EUR", period: "year", raw: "EUR 90000-110000" },
      postedAt: "2026-11-01",
      validThrough: null,
      description: null,
      sourceRef: "greenhouse:acme:1",
    },
  };
}

describe("JobService.create", () => {
  it("creates a job folder from pasted text", async () => {
    const t = await setup();
    try {
      const record = await t.service.create(textJob);
      assert.equal(record.id, `${localIsoDate()}_acme-corp_engineering-manager`);
      assert.equal(record.summary.state, "found");
      assert.deepEqual(record.files, ["posting.md", "status.yaml"]);
      const posting = await readFile(join(t.root, "jobs", record.id, "posting.md"), "utf8");
      const split = splitFrontmatter(posting);
      const front = parse(split.yaml ?? "");
      assert.equal(front.source, "manual-text");
      assert.equal(front.workplace, "remote");
      assert.equal(front.url, undefined);
      assert.match(front.text_sha256, /^[0-9a-f]{64}$/);
      assert.equal(split.body, "About the role\n\nLead the platform team.\n");
      assert.equal(record.diagnostics.length, 0);
    } finally {
      await t.cleanup();
    }
  });

  it("stores the snapshot and extracted facts for URL jobs, user fields win", async () => {
    const t = await setup();
    try {
      const record = await t.service.create(
        {
          kind: "url",
          token: "t",
          company: "Acme",
          title: "EM",
          location: "Remote (EU)",
          workplace: "remote",
          employmentType: "full-time",
        },
        snapshot(),
      );
      assert.deepEqual(record.files, ["posting.html", "posting.md", "status.yaml"]);
      assert.equal(record.posting?.company, "Acme");
      assert.equal(record.posting?.url, "https://jobs.example.com/acme/1");
      assert.equal(record.posting?.location, "Remote (EU)");
      assert.equal(record.posting?.source_ref, "greenhouse:acme:1");
      assert.equal(record.posting?.salary?.max, 110000);
      assert.equal(record.posting?.posted_at, "2026-11-01");
      assert.equal(record.posting?.fetched_at, "2026-11-16T10:00:00+01:00");
      assert.equal(record.hasRawHtml, true);
    } finally {
      await t.cleanup();
    }
  });

  it("adds a suffix when the same role is added twice on one day", async () => {
    const t = await setup();
    try {
      const first = await t.service.create(textJob);
      const second = await t.service.create(textJob);
      assert.equal(second.id, `${first.id}-2`);
      assert.equal(t.index.list().length, 2);
    } finally {
      await t.cleanup();
    }
  });
});

describe("JobService.transition", () => {
  it("records moves and enforces the state machine", async () => {
    const t = await setup();
    try {
      const { id } = await t.service.create(textJob);
      const moved = await t.service.transition(id, { to: "evaluated" });
      assert.equal(moved.summary.state, "evaluated");
      assert.deepEqual(
        moved.status?.history.map((e) => [e.from, e.to]),
        [
          [null, "found"],
          ["found", "evaluated"],
        ],
      );
      await assert.rejects(t.service.transition(id, { to: "offer" }), (e: HttpError) => {
        assert.equal(e.status, 409);
        assert.equal(e.code, "not-allowed");
        return true;
      });
      await t.service.transition(id, { to: "tailoring" });
      await assert.rejects(t.service.transition(id, { to: "ready" }), (e: HttpError) => {
        assert.equal(e.code, "guard");
        assert.match(e.message, /tailored CV/);
        return true;
      });
      await assert.rejects(t.service.transition(id, { to: "skipped" }), (e: HttpError) => {
        assert.equal(e.status, 400);
        return true;
      });
    } finally {
      await t.cleanup();
    }
  });

  it("supports applying externally and moving on from there", async () => {
    const t = await setup();
    try {
      const { id } = await t.service.create(textJob);
      const applied = await t.service.transition(id, {
        to: "applied",
        method: "external",
        reason: "Applied via LinkedIn in October",
      });
      assert.equal(applied.summary.appliedExternally, true);
      const screening = await t.service.transition(id, { to: "screening" });
      assert.equal(screening.summary.state, "screening");
    } finally {
      await t.cleanup();
    }
  });

  it("serialises concurrent moves on one job", async () => {
    const t = await setup();
    try {
      const { id } = await t.service.create(textJob);
      const results = await Promise.allSettled([
        t.service.transition(id, { to: "evaluated" }),
        t.service.transition(id, { to: "tailoring" }),
        t.service.addNote(id, "Parallel note"),
      ]);
      assert.deepEqual(
        results.map((r) => r.status),
        ["fulfilled", "fulfilled", "fulfilled"],
      );
      const record = t.index.get(id);
      assert.equal(record?.summary.state, "tailoring");
      assert.equal(record?.status?.history.length, 3);
      assert.equal(record?.status?.notes.length, 1);
    } finally {
      await t.cleanup();
    }
  });

  it("refuses to write over a broken status.yaml", async () => {
    const t = await setup();
    try {
      const { id } = await t.service.create(textJob);
      await writeFile(join(t.root, "jobs", id, "status.yaml"), "state: [broken\n");
      await assert.rejects(t.service.transition(id, { to: "evaluated" }), /has errors/);
    } finally {
      await t.cleanup();
    }
  });

  it("reports per-job results for bulk moves", async () => {
    const t = await setup();
    try {
      const a = await t.service.create(textJob);
      const b = await t.service.create({ ...textJob, title: "Staff Engineer" });
      await t.service.transition(b.id, { to: "evaluated" });
      await t.service.transition(b.id, { to: "tailoring" });
      const result = await t.service.bulkTransition([a.id, b.id, a.id], { to: "evaluated" });
      assert.deepEqual(
        result.results.map((r) => [r.id, r.ok]),
        [
          [a.id, true],
          [b.id, true],
        ],
      );
      const skip = await t.service.bulkTransition([a.id, "2026-01-01_nope_nope"], {
        to: "skipped",
        reason: "Not a fit",
      });
      assert.deepEqual(
        skip.results.map((r) => r.ok),
        [true, false],
      );
    } finally {
      await t.cleanup();
    }
  });
});

describe("notes and contacts", () => {
  it("adds and deletes with a staleness check", async () => {
    const t = await setup();
    try {
      const { id } = await t.service.create(textJob);
      const withNote = await t.service.addNote(id, "  Referral via Ana  ");
      const note = withNote.status?.notes[0];
      assert.equal(note?.text, "Referral via Ana");
      await assert.rejects(t.service.deleteNote(id, 0, "2000-01-01T00:00:00+00:00"), /changed/);
      const cleared = await t.service.deleteNote(id, 0, note?.at ?? "");
      assert.equal(cleared.status?.notes.length, 0);

      const withContact = await t.service.addContact(id, { name: "Jane Doe", role: "recruiter" });
      assert.equal(withContact.status?.contacts[0]?.name, "Jane Doe");
      await assert.rejects(t.service.deleteContact(id, 0, "Someone Else"), /changed/);
      const none = await t.service.deleteContact(id, 0, "Jane Doe");
      assert.equal(none.status?.contacts.length, 0);
    } finally {
      await t.cleanup();
    }
  });
});
