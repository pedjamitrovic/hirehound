import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  it("splits rows and fields", () => {
    assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas, escaped quotes and line breaks", () => {
    const text = 'Title,Description\n"Lead, Platform","Said ""ship it""\nthen shipped"\n';
    assert.deepEqual(parseCsv(text), [
      ["Title", "Description"],
      ["Lead, Platform", 'Said "ship it"\nthen shipped'],
    ]);
  });

  it("accepts CRLF line endings, also inside quoted fields", () => {
    assert.deepEqual(parseCsv('a,b\r\n"x\r\ny",z\r\n'), [
      ["a", "b"],
      ["x\ny", "z"],
    ]);
  });

  it("strips a byte order mark", () => {
    assert.deepEqual(parseCsv("\ufeffFirst Name,Last Name\nAlex,Example\n"), [
      ["First Name", "Last Name"],
      ["Alex", "Example"],
    ]);
  });

  it("ignores the final line break but keeps empty fields", () => {
    assert.deepEqual(parseCsv("a,,c,\n"), [["a", "", "c", ""]]);
    assert.deepEqual(parseCsv('""\n'), [[""]]);
    assert.deepEqual(parseCsv(""), []);
    assert.deepEqual(parseCsv("\n"), [[""]]);
  });

  it("keeps blank lines in the middle as rows with one empty field", () => {
    assert.deepEqual(parseCsv("a\n\nb\n"), [["a"], [""], ["b"]]);
  });

  it("treats empty quoted fields and quoted quotes correctly", () => {
    assert.deepEqual(parseCsv('"",""""\n'), [["", '"']]);
  });

  it("is lenient with stray quotes", () => {
    assert.deepEqual(parseCsv('5" screen,"closed"tail\n'), [['5" screen', "closedtail"]]);
    assert.deepEqual(parseCsv('a,"never closed\nstill open'), [["a", "never closed\nstill open"]]);
  });
});
