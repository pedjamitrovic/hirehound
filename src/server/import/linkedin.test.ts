import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeZip } from "../../../test/zip-writer.ts";
import { isLinkedInExport, linkedInToText } from "./linkedin.ts";
import { listZip } from "./zip.ts";

// Everything below is synthetic. Column sets follow LinkedIn's export format.

function csv(rows: string[][]): string {
  const quote = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${rows.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

function exportZip(files: Record<string, string>): Buffer {
  return makeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

const PROFILE = csv([
  [
    "First Name",
    "Last Name",
    "Maiden Name",
    "Address",
    "Birth Date",
    "Headline",
    "Summary",
    "Industry",
    "Zip Code",
    "Geo Location",
    "Twitter Handles",
    "Websites",
    "Instant Messengers",
  ],
  [
    "Alex",
    "Example",
    "Sample",
    "1 Synthetic Street",
    "Jan 1, 1990",
    "Engineering Manager",
    "I build platform teams.\n\n\n\n  Reach me at alex@example.com.  ",
    "Software Development",
    "10115",
    "Berlin, Germany",
    "[alexexample]",
    "[PORTFOLIO:https://alex.example]",
    "[SKYPE:alex.example.im]",
  ],
]);

const POSITIONS = csv([
  ["Company Name", "Title", "Description", "Location", "Started On", "Finished On"],
  [
    "Acme Robotics",
    "Engineering Manager",
    "Led a team of 8.\nShipped the fleet API.",
    "Berlin, Germany",
    "Mar 2021",
    "",
  ],
  ["Globex", "Senior Engineer", "", "", "Jan 2017", "Feb 2021"],
]);

describe("isLinkedInExport", () => {
  it("recognises exports by Positions.csv or Profile.csv in any folder and any case", () => {
    const detect = (...names: string[]) =>
      isLinkedInExport(listZip(makeZip(names.map((name) => ({ name, data: "x" })))));
    assert.equal(detect("Positions.csv", "Connections.csv"), true);
    assert.equal(detect("Basic_LinkedInDataExport_11-18-2026/PROFILE.CSV"), true);
    assert.equal(detect("cv.docx", "notes.txt"), false);
    assert.equal(detect("Profile.csv/"), false);
    assert.equal(detect("MyPositions.csv"), false);
  });
});

describe("linkedInToText", () => {
  it("renders profile and positions", () => {
    const text = linkedInToText(exportZip({ "Profile.csv": PROFILE, "Positions.csv": POSITIONS }));
    assert.equal(
      text,
      [
        "# LinkedIn export",
        "",
        "## Profile",
        "Name: Alex Example",
        "Headline: Engineering Manager",
        "Industry: Software Development",
        "Location: Berlin, Germany",
        "Websites: [PORTFOLIO:https://alex.example]",
        "Summary:",
        "I build platform teams.",
        "",
        "Reach me at [email removed].",
        "",
        "## Positions",
        "### Engineering Manager at Acme Robotics",
        "Dates: Mar 2021 - present",
        "Location: Berlin, Germany",
        "Led a team of 8.",
        "Shipped the fleet API.",
        "",
        "### Senior Engineer at Globex",
        "Dates: Jan 2017 - Feb 2021",
      ].join("\n"),
    );
  });

  it("never outputs private profile columns", () => {
    const text = linkedInToText(exportZip({ "Profile.csv": PROFILE }));
    for (const secret of [
      "Sample",
      "Synthetic Street",
      "1990",
      "10115",
      "alexexample",
      "SKYPE",
      "alex@example.com",
    ]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
  });

  it("never reads files outside the allowlist", () => {
    const text = linkedInToText(
      exportZip({
        "Positions.csv": POSITIONS,
        "messages.csv": csv([
          ["FROM", "CONTENT"],
          ["Sam", "private message text"],
        ]),
        "Connections.csv": csv([
          ["First Name", "Email Address"],
          ["Sam", "sam@example.org"],
        ]),
        "Email Addresses.csv": csv([["Email Address"], ["alex@example.org"]]),
        "PhoneNumbers.csv": csv([
          ["Extension", "Number", "Type"],
          ["", "+1 555 0100", "Mobile"],
        ]),
        "Ad_Targeting.csv": csv([["Member Age"], ["25 to 34"]]),
      }),
    );
    for (const secret of [
      "private message",
      "sam@example.org",
      "alex@example.org",
      "555",
      "Member Age",
    ]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.match(text, /## Positions/);
  });

  it("skips preamble lines and maps columns by name", () => {
    const education = [
      "Notes:",
      '"This file lists education entries you added to your profile, in any order."',
      "",
      csv([
        ["Degree Name", "Notes", "School Name", "End Date", "Start Date", "Activities"],
        ["BSc Computer Science", "Thesis on scheduling", "Example University", "2014", "2010", ""],
        ["", "", "Night School", "", "2015", "Chess club,\nDebate"],
      ]),
    ].join("\r\n");
    const text = linkedInToText(exportZip({ "export/Education.csv": education }));
    assert.equal(
      text,
      [
        "# LinkedIn export",
        "",
        "## Education",
        "### Example University",
        "Degree: BSc Computer Science",
        "Dates: 2010 - 2014",
        "Notes: Thesis on scheduling",
        "",
        "### Night School",
        "Dates: 2015 - ?",
        "Activities:",
        "Chess club,",
        "Debate",
      ].join("\n"),
    );
  });

  it("renders the remaining sections", () => {
    const text = linkedInToText(
      exportZip({
        "Skills.csv": csv([["Name"], ["TypeScript"], ["Kubernetes"]]),
        "Languages.csv": csv([
          ["Name", "Proficiency"],
          ["German", "Native or bilingual proficiency"],
          ["Spanish", ""],
        ]),
        "Certifications.csv": csv([
          ["Name", "Url", "Authority", "Started On", "Finished On", "License Number"],
          [
            "Cloud Architect",
            "https://cert.example/1",
            "Example Cloud",
            "May 2022",
            "May 2025",
            "EX-123",
          ],
        ]),
        "Projects.csv": csv([
          ["Title", "Description", "Url", "Started On", "Finished On"],
          ["Fleet simulator", "Open source simulator.", "", "Jun 2020", ""],
        ]),
        "Honors.csv": csv([
          ["Title", "Description", "Issued On"],
          ["Hackathon winner", "", "Oct 2019"],
        ]),
        "Publications.csv": csv([
          ["Name", "Published On", "Description", "Publisher", "Url"],
          ["Scheduling at scale", "Feb 2022", "", "Example Press", "https://pub.example/2"],
        ]),
        "Volunteering.csv": csv([
          ["Company Name", "Role", "Cause", "Started On", "Finished On", "Description"],
          ["Code Club", "Mentor", "Education", "Sep 2018", "", "Taught Python to teenagers."],
        ]),
        "Recommendations_Received.csv": csv([
          ["First Name", "Last Name", "Company", "Job Title", "Text", "Creation Date", "Status"],
          [
            "Sam",
            "Sample",
            "Acme Robotics",
            "CTO",
            "Alex is a great manager.",
            "01/02/23",
            "VISIBLE",
          ],
          ["Pat", "Hidden", "Globex", "VP", "Should not appear.", "01/02/22", "HIDDEN"],
          ["Kim", "Draft", "Initech", "Lead", "Pending text.", "01/02/21", "PENDING"],
        ]),
      }),
    );
    assert.equal(
      text,
      [
        "# LinkedIn export",
        "",
        "## Skills",
        "- TypeScript",
        "- Kubernetes",
        "",
        "## Certifications",
        "### Cloud Architect",
        "Authority: Example Cloud",
        "Issued: May 2022",
        "Expires: May 2025",
        "License number: EX-123",
        "URL: https://cert.example/1",
        "",
        "## Languages",
        "- German (Native or bilingual proficiency)",
        "- Spanish",
        "",
        "## Projects",
        "### Fleet simulator",
        "Dates: Jun 2020 - present",
        "Open source simulator.",
        "",
        "## Honors and awards",
        "### Hackathon winner",
        "Issued: Oct 2019",
        "",
        "## Publications",
        "### Scheduling at scale",
        "Publisher: Example Press",
        "Published: Feb 2022",
        "URL: https://pub.example/2",
        "",
        "## Volunteering",
        "### Mentor at Code Club",
        "Cause: Education",
        "Dates: Sep 2018 - present",
        "Taught Python to teenagers.",
        "",
        "## Recommendations received",
        "### From Sam Sample",
        "Role: CTO at Acme Robotics",
        "Date: 01/02/23",
        "Alex is a great manager.",
      ].join("\n"),
    );
  });

  it("skips empty sections and files without a header row", () => {
    const text = linkedInToText(
      exportZip({
        "Positions.csv": POSITIONS,
        "Skills.csv": csv([["Name"]]),
        "Languages.csv": "",
        "Projects.csv": csv([["Something else"], ["value"]]),
        "Recommendations_Received.csv": csv([
          ["First Name", "Text", "Status"],
          ["Pat", "Hidden text", "HIDDEN"],
          ["Kim", "", "VISIBLE"],
        ]),
      }),
    );
    assert.deepEqual(
      text.split("\n").filter((line) => line.startsWith("## ")),
      ["## Positions"],
    );
  });

  it("returns an empty string when nothing career-related is present", () => {
    assert.equal(linkedInToText(exportZip({ "Connections.csv": "First Name\nSam\n" })), "");
    assert.equal(linkedInToText(exportZip({ "Profile.csv": csv([["First Name"]]) })), "");
  });
});
