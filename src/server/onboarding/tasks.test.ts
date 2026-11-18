import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BankFile } from "../../shared/schemas/bank.ts";
import {
  type ApplyAnswersOutput,
  applyAnswersTask,
  type DraftBankOutput,
  draftBankTask,
  draftBaseTask,
  draftToEntries,
  proposalToOps,
} from "./tasks.ts";

const bank = BankFile.parse({
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
          id: "ACH-001",
          text: "Grew the team from 4 to 14",
          metrics: ["4 to 14"],
          confirmed: true,
        },
        { id: "ACH-002", text: "Draft claim", confirmed: false },
      ],
    },
  ],
});

const emptyDraft: DraftBankOutput = {
  contact: { name: null, email: null, phone: null, location: null, links: [] },
  roles: [],
  projects: [],
  education: [],
  certifications: [],
  skills: [],
  languages: [],
  awards: [],
  questions: [],
};

describe("draftBankTask.postCheck", () => {
  const input = {
    sources: [{ name: "cv.pdf", attachment: { kind: "text" as const, name: "cv.pdf", text: "x" } }],
    existing: null,
  };

  it("accepts consistent refs and sources", () => {
    const output: DraftBankOutput = {
      ...emptyDraft,
      skills: [{ ref: "s1", name: "Languages", items: ["Go"], source: "cv.pdf" }],
      questions: [{ about: "s1", question: "Which version?", why: "Precision" }],
    };
    assert.deepEqual(draftBankTask.postCheck?.(output, input), []);
  });

  it("flags unknown sources, duplicate refs and dangling question refs", () => {
    const output: DraftBankOutput = {
      ...emptyDraft,
      skills: [
        { ref: "s1", name: "Languages", items: ["Go"], source: "made-up.pdf" },
        { ref: "s1", name: "Cloud", items: ["AWS"], source: "cv.pdf" },
      ],
      questions: [{ about: "nope", question: "Q?", why: "W" }],
    };
    const problems = draftBankTask.postCheck?.(output, input) ?? [];
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /made-up\.pdf/);
    assert.match(problems.join("\n"), /used twice/);
    assert.match(problems.join("\n"), /unknown ref "nope"/);
  });

  it("drops unstated fields when converting to bank entries", () => {
    const entries = draftToEntries(
      {
        ...emptyDraft,
        roles: [
          {
            ref: "r1",
            company: "Acme",
            title: "EM",
            start: null,
            end: "present",
            location: null,
            employment_type: null,
            summary: null,
            source: "cv.pdf",
            achievements: [
              { ref: "a1", text: "Did X", detail: null, metrics: [], skills: [], source: "cv.pdf" },
            ],
          },
        ],
      },
      (name) => `imports/${name}`,
    );
    assert.deepEqual(entries[0]?.entry, {
      company: "Acme",
      title: "EM",
      end: "present",
      source: "imports/cv.pdf",
    });
    assert.deepEqual(entries[0]?.achievements?.[0]?.entry, {
      text: "Did X",
      metrics: [],
      skills: [],
      source: "imports/cv.pdf",
    });
  });
});

describe("applyAnswersTask", () => {
  const answered = [{ id: "Q-001", question: "How many?", answer: "12" }];

  it("rejects unknown ids, forbidden fields and orphan achievements", () => {
    const output: ApplyAnswersOutput = {
      changes: [
        { id: "ACH-404", field: "text", value: "x", question: "Q-001" },
        { id: "ROLE-001", field: "confirmed", value: "true", question: "Q-001" },
        { id: "ACH-001", field: "text", value: "x", question: "Q-999" },
      ],
      additions: [{ kind: "achievement", parent: "ACH-001", fields: [], question: "Q-001" }],
      unused: [],
    };
    const problems = applyAnswersTask.postCheck?.(output, { bank, answered }) ?? [];
    assert.equal(problems.length, 4);
  });

  it("turns changes into upserts that need review again", () => {
    const { ops, changes } = proposalToOps(bank, {
      changes: [
        { id: "ACH-001", field: "metrics", value: ["4 to 14", "12 months"], question: "Q-001" },
        {
          id: "ACH-001",
          field: "text",
          value: "Grew the team from 4 to 14 in 12 months",
          question: "Q-001",
        },
      ],
      additions: [
        {
          kind: "achievement",
          parent: "ROLE-001",
          fields: [{ field: "text", value: "Hired two leads" }],
          question: "Q-001",
        },
      ],
      unused: [],
    });
    assert.equal(ops.length, 2);
    assert.deepEqual(ops[0], {
      op: "upsert",
      kind: "achievement",
      entry: {
        id: "ACH-001",
        text: "Grew the team from 4 to 14 in 12 months",
        metrics: ["4 to 14", "12 months"],
        skills: [],
        confirmed: false,
        tags: [],
      },
    });
    assert.equal(changes[0]?.before?.text, "Grew the team from 4 to 14");
    assert.deepEqual(ops[1], {
      op: "upsert",
      kind: "achievement",
      parent: "ROLE-001",
      entry: { text: "Hired two leads", source: "answers", confirmed: false },
    });
  });
});

describe("draftBaseTask.postCheck", () => {
  const input = {
    spec: { label: "EM", track: "management" as const, target_titles: [], emphasis: [] },
    bank,
    name: null,
    maxPages: 2,
  };

  it("accepts a fully evidenced CV citing confirmed entries", () => {
    const body =
      "## Experience\n\n### Engineering Manager, Acme Robotics <!-- ev: ROLE-001 -->\n\n- Grew the team from 4 to 14 <!-- ev: ACH-001 -->\n";
    assert.deepEqual(draftBaseTask.postCheck?.({ headline: "EM", body, notes: "" }, input), []);
  });

  it("rejects unconfirmed or unknown ids, missing markers and bad syntax", () => {
    const body = [
      "# Name",
      "",
      "## Experience",
      "",
      "- Uses a draft claim <!-- ev: ACH-002 -->",
      "- Cites nothing",
      "- Invents <!-- ev: ACH-999 -->",
    ].join("\n");
    const problems = draftBaseTask.postCheck?.({ headline: "EM", body, notes: "" }, input) ?? [];
    assert.ok(
      problems.some((p) => p.startsWith("line 1:")),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => /ACH-002/.test(p)),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => /ACH-999/.test(p)),
      problems.join("\n"),
    );
    assert.ok(
      problems.some((p) => p.startsWith("line 6:")),
      problems.join("\n"),
    );
  });
});
