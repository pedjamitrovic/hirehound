import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { BankFile } from "../../shared/schemas/bank.ts";
import type { HttpError } from "../http/router.ts";
import { applyBankOps, BANK_HEADER, bankToYaml } from "./bank-ops.ts";

const START = `# My bank, hand-edited.
version: 1
id_counters: { ACH: 9 }
roles:
  # Current job
  - id: ROLE-001
    company: Acme Robotics
    title: Engineering Manager
    start: 2021-03
    end: present
    confirmed: true
    achievements:
      - id: ACH-001
        text: Grew the platform group from 4 to 14 engineers
        metrics: [4 to 14 engineers]
        confirmed: false
skills:
  - id: SKL-001
    name: Languages
    items: [TypeScript, Go]
`;

describe("applyBankOps", () => {
  it("creates entries with fresh ids and records counters, keeping comments", () => {
    const result = applyBankOps(START, [
      {
        op: "upsert",
        kind: "achievement",
        parent: "ROLE-001",
        entry: { text: "Cut p95 latency by 40%" },
      },
      { op: "upsert", kind: "language", entry: { name: "Serbian", level: "Native" } },
    ]);
    assert.deepEqual(result.created, ["ACH-010", "LANG-001"]);
    assert.match(result.text, /^# My bank, hand-edited\./);
    assert.match(result.text, /# Current job/);
    const js = parse(result.text);
    assert.equal(js.roles[0].achievements[1].id, "ACH-010");
    assert.equal(js.roles[0].achievements[1].confirmed, false);
    assert.equal(js.languages[0].id, "LANG-001");
    assert.deepEqual(js.id_counters, { ACH: 10, LANG: 1, ROLE: 1, SKL: 1 });
  });

  it("updates an entry in place: replaces fields, removes cleared ones, keeps achievements", () => {
    const result = applyBankOps(START, [
      {
        op: "upsert",
        kind: "role",
        entry: {
          id: "ROLE-001",
          company: "Acme Robotics GmbH",
          title: "Engineering Manager",
          start: "2021-03",
          end: "present",
          location: "Berlin",
          confirmed: true,
        },
      },
    ]);
    const role = result.bank.roles[0];
    assert.equal(role?.company, "Acme Robotics GmbH");
    assert.equal(role?.location, "Berlin");
    assert.equal(role?.achievements.length, 1);
    assert.match(result.text, /# Current job/);
    // A new field lands before the achievements list, not after it.
    assert.ok(result.text.indexOf("location: Berlin") < result.text.indexOf("achievements:"));
  });

  it("confirms and deletes, and never reuses a deleted id", () => {
    const confirmed = applyBankOps(START, [{ op: "confirm", ids: ["ACH-001"], confirmed: true }]);
    assert.equal(confirmed.bank.roles[0]?.achievements[0]?.confirmed, true);

    const deleted = applyBankOps(START, [{ op: "delete", id: "SKL-001" }]);
    assert.equal(deleted.bank.skills.length, 0);
    const again = applyBankOps(deleted.text, [
      { op: "upsert", kind: "skill", entry: { name: "Cloud", items: ["AWS"] } },
    ]);
    assert.deepEqual(again.created, ["SKL-002"]);
  });

  it("rejects invalid entries with a readable message and unknown ids with 404", () => {
    assert.throws(
      () =>
        applyBankOps(START, [
          {
            op: "upsert",
            kind: "role",
            entry: { company: "X", title: "Y", start: "March 2020", end: "present" },
          },
        ]),
      (error: HttpError) => error.status === 400 && /start/.test(error.message),
    );
    assert.throws(
      () => applyBankOps(START, [{ op: "delete", id: "ROLE-404" }]),
      (error: HttpError) => error.status === 404,
    );
    assert.throws(
      () =>
        applyBankOps(START, [
          { op: "upsert", kind: "skill", entry: { id: "ROLE-001", name: "x", items: ["y"] } },
        ]),
      (error: HttpError) => error.code === "kind-mismatch",
    );
  });

  it("starts a new file when there is none", () => {
    const result = applyBankOps(null, [
      {
        op: "upsert",
        kind: "role",
        entry: { company: "A", title: "B", start: "2020", end: "2021" },
      },
    ]);
    assert.ok(result.text.startsWith(BANK_HEADER));
    assert.equal(result.bank.roles[0]?.id, "ROLE-001");
  });

  it("refuses to edit a broken file", () => {
    assert.throws(
      () => applyBankOps("roles: [unclosed\n", [{ op: "delete", id: "ROLE-001" }]),
      (error: HttpError) => error.status === 409,
    );
  });
});

describe("bankToYaml", () => {
  it("writes a tidy file that parses back to the same bank", () => {
    const bank = BankFile.parse(parse(START));
    const text = bankToYaml(bank);
    assert.ok(text.startsWith(BANK_HEADER));
    assert.doesNotMatch(text, /tags: \[\]/);
    assert.deepEqual(BankFile.parse(parse(text)), bank);
  });
});
