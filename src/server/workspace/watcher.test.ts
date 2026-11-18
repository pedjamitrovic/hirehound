import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventually, sampleStatus, tempWorkspace, writeJob } from "../../../test/helpers.ts";
import { classifyChange, watchWorkspace } from "./watcher.ts";

describe("classifyChange", () => {
  it("routes job, profile and folder-level changes", () => {
    assert.deepEqual(classifyChange("jobs/2026-11-16_a_b/status.yaml"), {
      kind: "job",
      id: "2026-11-16_a_b",
    });
    assert.deepEqual(classifyChange("jobs\\2026-11-16_a_b\\posting.md"), {
      kind: "job",
      id: "2026-11-16_a_b",
    });
    assert.deepEqual(classifyChange("jobs"), { kind: "rescan" });
    assert.deepEqual(classifyChange("profile/contact.yaml"), { kind: "profile" });
    assert.deepEqual(classifyChange("hirehound.yaml"), { kind: "profile" });
    assert.deepEqual(classifyChange(null), { kind: "rescan" });
  });

  it("ignores noise", () => {
    assert.equal(classifyChange(".git/index"), null);
    assert.equal(classifyChange("jobs/x/status.yaml.tmp-123-abcdef01"), null);
    assert.equal(classifyChange("jobs/x/.status.yaml.swp"), null);
    assert.equal(classifyChange("profile/contact.yaml~"), null);
    assert.equal(classifyChange("README.md"), null);
  });
});

const ID = "2026-11-16_acme_engineering-manager";

for (const forcePolling of [false, true]) {
  describe(`watchWorkspace (${forcePolling ? "polling" : "native"})`, () => {
    it("reports a changed job folder", async () => {
      const ws = await tempWorkspace();
      const seen = new Set<string>();
      let rescans = 0;
      const watcher = watchWorkspace(
        ws.root,
        {
          job: async (id) => {
            seen.add(id);
          },
          profile: async () => {},
          rescan: async () => {
            rescans++;
          },
        },
        { debounceMs: 20, pollMs: 50, forcePolling },
      );
      try {
        assert.equal(watcher.mode, forcePolling ? "polling" : "watching");
        await writeJob(ws.root, ID, { status: sampleStatus() });
        // Native mode reports the job folder; polling mode rescans everything.
        await eventually(() => (forcePolling ? rescans > 0 : seen.has(ID)));
      } finally {
        watcher.close();
        await ws.cleanup();
      }
    });
  });
}
