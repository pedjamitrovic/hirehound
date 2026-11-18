import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { updateYamlText } from "./yaml-edit.ts";

describe("updateYamlText", () => {
  it("keeps comments and order while changing, adding and removing keys", () => {
    const text = [
      "# Contact details",
      "version: 1",
      "name: Alex # full name",
      "email: alex@example.com",
      "phone: '+381 60 000'",
      "links:",
      "  - label: GitHub",
      "    url: https://github.com/a",
      "",
    ].join("\n");
    const next = updateYamlText(text, {
      version: 1,
      name: "Alex Example",
      email: "alex@example.com",
      location: "Belgrade",
      links: [{ label: "Site", url: "https://a.example" }],
    });
    assert.match(next, /^# Contact details/);
    assert.match(next, /name: Alex Example # full name/);
    assert.doesNotMatch(next, /phone/);
    assert.deepEqual(parse(next), {
      version: 1,
      name: "Alex Example",
      email: "alex@example.com",
      links: [{ label: "Site", url: "https://a.example" }],
      location: "Belgrade",
    });
  });

  it("writes a fresh file for a missing or commented-out template", () => {
    const header = "# Written by Hirehound\n";
    assert.equal(updateYamlText(null, { a: 1 }, header), "# Written by Hirehound\na: 1\n");
    assert.equal(
      updateYamlText("# name: x\n# email: y\n", { a: 1 }, header),
      "# Written by Hirehound\na: 1\n",
    );
  });

  it("merges nested maps and drops undefined values", () => {
    const next = updateYamlText("location:\n  city: Belgrade # home\n  country: RS\n", {
      location: { city: "Novi Sad", country: "RS", extra: undefined },
    });
    assert.match(next, /city: Novi Sad # home/);
    assert.deepEqual(parse(next), { location: { city: "Novi Sad", country: "RS" } });
  });
});
