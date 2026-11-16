import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JobState, StatusEvent, StatusFile } from "./schemas/status.ts";
import {
  applyTransition,
  checkTransition,
  type GuardContext,
  NO_CV,
  neighbourInPipeline,
  reopenTarget,
  transitionOptions,
} from "./states.ts";

const AT = "2026-11-16T10:00:00+01:00";

function statusIn(state: JobState, history: StatusEvent[] = []): StatusFile {
  return {
    version: 1,
    state,
    history: history.length ? history : [{ at: AT, from: null, to: state, by: "user" }],
    notes: [],
    contacts: [],
    tags: [],
  };
}

describe("checkTransition", () => {
  it("allows plain pipeline edges", () => {
    assert.deepEqual(checkTransition(statusIn("found"), { to: "evaluated" }, NO_CV), {
      ok: true,
      kind: "edge",
    });
    assert.ok(checkTransition(statusIn("applied"), { to: "interviewing" }, NO_CV).ok);
    assert.ok(checkTransition(statusIn("offer"), { to: "accepted" }, NO_CV).ok);
  });

  it("rejects moves that are not edges", () => {
    const result = checkTransition(statusIn("found"), { to: "offer" }, NO_CV);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "not-allowed");
  });

  it("rejects moving to the current state", () => {
    assert.equal(checkTransition(statusIn("found"), { to: "found" }, NO_CV).ok, false);
  });

  it("guards ready behind a verified CV", () => {
    const blocked = checkTransition(statusIn("tailoring"), { to: "ready" }, NO_CV);
    assert.equal(!blocked.ok && blocked.code, "guard");
    const verified: GuardContext = { cvVerified: true, cvPdfSha256: null };
    assert.ok(checkTransition(statusIn("tailoring"), { to: "ready" }, verified).ok);
  });

  it("guards approved behind a rendered PDF", () => {
    assert.equal(checkTransition(statusIn("ready"), { to: "approved" }, NO_CV).ok, false);
    const withPdf: GuardContext = { cvVerified: true, cvPdfSha256: "a".repeat(64) };
    assert.ok(checkTransition(statusIn("ready"), { to: "approved" }, withPdf).ok);
  });

  it("refuses to apply when the PDF changed after approval", () => {
    const approved: StatusFile = {
      ...statusIn("approved"),
      approval: { at: AT, cv_sha256: "a".repeat(64), base: "em" },
    };
    const same: GuardContext = { cvVerified: true, cvPdfSha256: "a".repeat(64) };
    const changed: GuardContext = { cvVerified: true, cvPdfSha256: "b".repeat(64) };
    assert.ok(checkTransition(approved, { to: "applied" }, same).ok);
    const result = checkTransition(approved, { to: "applied" }, changed);
    assert.equal(!result.ok && result.code, "guard");
    assert.match(!result.ok ? result.message : "", /changed after it was approved/);
  });

  it("refuses a normal apply without any approval", () => {
    const result = checkTransition(statusIn("approved"), { to: "applied" }, NO_CV);
    assert.equal(!result.ok && result.code, "guard");
  });

  it("requires a reason for skip, withdraw and external apply", () => {
    const skip = checkTransition(statusIn("found"), { to: "skipped" }, NO_CV);
    assert.equal(!skip.ok && skip.code, "reason-required");
    assert.ok(
      checkTransition(statusIn("found"), { to: "skipped", reason: "Too junior" }, NO_CV).ok,
    );
    const blank = checkTransition(statusIn("applied"), { to: "withdrawn", reason: "   " }, NO_CV);
    assert.equal(!blank.ok && blank.code, "reason-required");
  });

  it("allows applied externally from any pre-apply state only", () => {
    const req = { to: "applied" as const, method: "external" as const, reason: "Applied in 2025" };
    for (const state of ["found", "evaluated", "tailoring", "ready", "approved"] as const) {
      assert.deepEqual(checkTransition(statusIn(state), req, NO_CV), {
        ok: true,
        kind: "external",
      });
    }
    assert.equal(checkTransition(statusIn("screening"), req, NO_CV).ok, false);
    assert.equal(
      checkTransition(statusIn("found"), { ...req, to: "screening" as const }, NO_CV).ok,
      false,
    );
  });

  it("reopens closed jobs only to the last open state", () => {
    const history: StatusEvent[] = [
      { at: AT, from: null, to: "found", by: "user" },
      { at: AT, from: "found", to: "evaluated", by: "user" },
      { at: AT, from: "evaluated", to: "skipped", by: "user", reason: "Not now" },
    ];
    const skipped = statusIn("skipped", history);
    assert.equal(reopenTarget(history), "evaluated");
    assert.deepEqual(checkTransition(skipped, { to: "evaluated" }, NO_CV), {
      ok: true,
      kind: "reopen",
    });
    assert.equal(checkTransition(skipped, { to: "found" }, NO_CV).ok, false);
  });

  it("never reopens accepted", () => {
    assert.equal(checkTransition(statusIn("accepted"), { to: "offer" }, NO_CV).ok, false);
    assert.deepEqual(transitionOptions(statusIn("accepted"), NO_CV), []);
  });
});

describe("reopenTarget", () => {
  it("falls back to found when history has no open state", () => {
    assert.equal(reopenTarget([{ at: AT, from: null, to: "skipped", by: "user" }]), "found");
  });
});

describe("transitionOptions", () => {
  it("lists blocked moves with their reason and offers external apply before applying", () => {
    const options = transitionOptions(statusIn("tailoring"), NO_CV);
    const ready = options.find((o) => o.to === "ready");
    assert.equal(ready?.allowed, false);
    assert.match(ready?.message ?? "", /verifier/);
    const external = options.find((o) => o.kind === "external");
    assert.deepEqual(external, {
      to: "applied",
      kind: "external",
      method: "external",
      allowed: true,
      needsReason: true,
    });
    assert.equal(options.find((o) => o.to === "skipped")?.needsReason, true);
  });

  it("offers no external apply once applied", () => {
    const options = transitionOptions(statusIn("applied"), NO_CV);
    assert.equal(
      options.some((o) => o.kind === "external"),
      false,
    );
  });
});

describe("applyTransition", () => {
  it("appends to history without mutating the input", () => {
    const before = statusIn("found");
    const after = applyTransition(
      before,
      { to: "skipped", reason: "  Too junior  " },
      { at: AT, by: "user" },
    );
    assert.equal(before.history.length, 1);
    assert.equal(after.state, "skipped");
    assert.deepEqual(after.history.at(-1), {
      at: AT,
      from: "found",
      to: "skipped",
      by: "user",
      reason: "Too junior",
    });
  });

  it("records an external application", () => {
    const after = applyTransition(
      statusIn("evaluated"),
      { to: "applied", method: "external", reason: "Via referral" },
      { at: AT, by: "user" },
    );
    assert.deepEqual(after.application, { at: AT, method: "external" });
  });
});

describe("neighbourInPipeline", () => {
  it("moves forward and back along allowed edges only", () => {
    assert.equal(neighbourInPipeline(statusIn("found"), 1, NO_CV), "evaluated");
    assert.equal(neighbourInPipeline(statusIn("evaluated"), -1, NO_CV), "found");
    assert.equal(neighbourInPipeline(statusIn("tailoring"), 1, NO_CV), null);
    assert.equal(neighbourInPipeline(statusIn("found"), -1, NO_CV), null);
    assert.equal(neighbourInPipeline(statusIn("skipped"), 1, NO_CV), null);
  });
});
