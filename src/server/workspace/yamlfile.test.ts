import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Preferences } from "../../shared/schemas/preferences.ts";
import { StatusFile } from "../../shared/schemas/status.ts";
import { parseYaml } from "./yamlfile.ts";

const file = "profile/preferences.yaml";

describe("parseYaml", () => {
  it("treats a fully commented file as empty", () => {
    const result = parseYaml("# nothing yet\n# name: x\n", Preferences, { file });
    assert.deepEqual(result, { value: null, empty: true, diagnostics: [] });
  });

  it("reports syntax errors with a line number", () => {
    const result = parseYaml("location:\n  based_in: [unclosed\n", Preferences, { file });
    assert.equal(result.value, null);
    assert.equal(result.diagnostics[0]?.severity, "error");
    assert.match(result.diagnostics[0]?.message ?? "", /^YAML syntax/);
    assert.equal(typeof result.diagnostics[0]?.line, "number");
  });

  it("reports schema errors at the offending line", () => {
    const text = [
      "location:",
      "  based_in:",
      "    country: Serbia",
      "  timezone: Europe/Belgrade",
    ].join("\n");
    const result = parseYaml(text, Preferences, { file });
    assert.equal(result.value, null);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0]?.message ?? "", /^location\.based_in\.country:/);
    assert.equal(result.diagnostics[0]?.line, 3);
  });

  it("points missing keys at their parent", () => {
    const result = parseYaml("location:\n  based_in: { country: RS }\n", Preferences, { file });
    const timezone = result.diagnostics.find((d) => d.message.startsWith("location.timezone"));
    assert.equal(timezone?.line, 1);
  });

  it("warns about unknown keys but keeps the value", () => {
    const text =
      "location:\n  based_in: { country: RS }\n  timezone: UTC\nscoring:\n  treshold: 80\n";
    const result = parseYaml(text, Preferences, { file });
    assert.ok(result.value);
    assert.deepEqual(result.diagnostics, [
      { file, severity: "warning", message: "scoring.treshold: unknown setting, ignored", line: 5 },
    ]);
  });

  it("offsets line numbers for frontmatter", () => {
    const result = parseYaml("state: bogus\nhistory: []\n", StatusFile, {
      file: "jobs/x/status.yaml",
      lineOffset: 1,
    });
    const state = result.diagnostics.find((d) => d.message.startsWith("state"));
    assert.equal(state?.line, 2);
  });

  it("rejects duplicate keys", () => {
    const result = parseYaml("a: 1\na: 2\n", Preferences, { file });
    assert.equal(result.value, null);
    assert.match(result.diagnostics[0]?.message ?? "", /YAML syntax/);
  });
});
