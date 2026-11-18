import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bankStats,
  bankToPromptText,
  entryLabel,
  IdAllocator,
  indexBank,
  kindOfId,
} from "./bank.ts";
import { BankFile } from "./schemas/bank.ts";

const bank = BankFile.parse({
  id_counters: { ACH: 20 },
  roles: [
    {
      id: "ROLE-001",
      company: "Acme Robotics",
      title: "Engineering Manager",
      start: "2021-03",
      end: "present",
      confirmed: true,
      achievements: [
        {
          id: "ACH-014",
          text: "Grew the platform group from 4 to 14 engineers",
          metrics: ["4 to 14 engineers", "18 months"],
          confirmed: true,
        },
        { id: "ACH-015", text: "Unreviewed claim", confirmed: false },
      ],
    },
  ],
  education: [{ id: "EDU-001", institution: "Example University", degree: "BSc", field: "CS" }],
  skills: [{ id: "SKL-001", name: "Languages", items: ["TypeScript", "Go"], confirmed: true }],
});

describe("BankFile schema", () => {
  it("rejects duplicate ids anywhere in the file", () => {
    const result = BankFile.safeParse({
      roles: [
        {
          id: "ROLE-001",
          company: "A",
          title: "T",
          start: "2020",
          end: "2021",
          achievements: [{ id: "ACH-001", text: "x" }],
        },
      ],
      projects: [{ id: "PRJ-001", name: "P", achievements: [{ id: "ACH-001", text: "y" }] }],
    });
    assert.equal(result.success, false);
    assert.match(result.error?.issues[0]?.message ?? "", /duplicate id ACH-001/);
  });

  it("checks id prefixes per kind and date order", () => {
    assert.equal(
      BankFile.safeParse({
        roles: [{ id: "ACH-001", company: "A", title: "T", start: "2020", end: "present" }],
      }).success,
      false,
    );
    const backwards = BankFile.safeParse({
      roles: [{ id: "ROLE-001", company: "A", title: "T", start: "2022-05", end: "2021-01" }],
    });
    assert.equal(backwards.success, false);
    assert.ok(
      BankFile.safeParse({
        roles: [{ id: "ROLE-001", company: "A", title: "T", start: "2021", end: "2021-06" }],
      }).success,
    );
  });

  it("accepts a bare year written as a YAML number", () => {
    const parsed = BankFile.parse({
      education: [{ id: "EDU-001", institution: "Example University", end: 2015 }],
    });
    assert.equal(parsed.education[0]?.end, "2015");
  });

  it("defaults confirmed to false", () => {
    const parsed = BankFile.parse({
      languages: [{ id: "LANG-001", name: "Serbian", level: "Native" }],
    });
    assert.equal(parsed.languages[0]?.confirmed, false);
  });
});

describe("indexBank", () => {
  it("finds nested achievements with their parent", () => {
    const index = indexBank(bank);
    assert.deepEqual([...index.keys()], ["ROLE-001", "ACH-014", "ACH-015", "EDU-001", "SKL-001"]);
    assert.equal(index.get("ACH-014")?.parent, "ROLE-001");
    assert.equal(kindOfId("CERT-007"), "certification");
    assert.equal(kindOfId("NOPE-1"), undefined);
  });

  it("labels entries for chips", () => {
    const index = indexBank(bank);
    const label = (id: string) => {
      const entry = index.get(id);
      return entry ? entryLabel(entry) : "";
    };
    assert.equal(label("ROLE-001"), "Engineering Manager at Acme Robotics");
    assert.equal(label("EDU-001"), "BSc, CS, Example University");
  });
});

describe("IdAllocator", () => {
  it("never reuses ids: respects stored counters and existing ids", () => {
    const ids = new IdAllocator(bank);
    assert.equal(ids.next("ACH"), "ACH-021");
    assert.equal(ids.next("ROLE"), "ROLE-002");
    assert.equal(ids.next("CERT"), "CERT-001");
    assert.deepEqual(ids.counters(), { ACH: 21, CERT: 1, EDU: 1, ROLE: 2, SKL: 1 });
  });
});

describe("bankStats and bankToPromptText", () => {
  it("counts confirmed entries", () => {
    const stats = bankStats(bank);
    assert.equal(stats.total, 5);
    assert.equal(stats.confirmed, 3);
    assert.equal(stats.byKind.achievement, 2);
  });

  it("renders id-prefixed lines and can hide unconfirmed entries", () => {
    const all = bankToPromptText(bank);
    assert.match(
      all,
      /^## Roles\nROLE-001: Engineering Manager at Acme Robotics \(2021-03 - present\)/,
    );
    assert.match(all, /ACH-015: Unreviewed claim/);
    assert.match(all, /metrics: 4 to 14 engineers; 18 months/);
    const confirmed = bankToPromptText(bank, { confirmedOnly: true });
    assert.doesNotMatch(confirmed, /ACH-015|EDU-001/);
    assert.match(confirmed, /SKL-001: Languages: TypeScript, Go/);
  });
});
