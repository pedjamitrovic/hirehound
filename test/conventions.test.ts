import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, it } from "node:test";

// Project convention (CLAUDE.md): no em dashes, en dashes or curly quotes in code, comments,
// strings, UI copy or our docs. Third-party text (job postings) may contain them at runtime;
// code refers to those characters through escapes such as "\\u2014".
const BANNED = [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCharCode(c));

const ROOTS = ["bin", "src", "test", "docs", ".github"];
const FILES = ["CLAUDE.md", "README.md", "package.json", "vite.config.ts", "biome.json"];
const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html", ".md", ".json", ".yml", ".yaml"]);
/** The PRD is the maintainer's document and keeps its own typography. */
const EXEMPT = new Set(["docs/PRD.md"]);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (EXTENSIONS.has(extname(entry.name))) yield path;
  }
}

describe("conventions", () => {
  it("uses no em dashes, en dashes or curly quotes", async () => {
    const offenders: string[] = [];
    const files: string[] = [...FILES];
    for (const root of ROOTS) for await (const file of walk(root)) files.push(file);
    for (const file of files) {
      const normalized = file.split("\\").join("/");
      if (EXEMPT.has(normalized)) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (BANNED.some((ch) => line.includes(ch))) offenders.push(`${normalized}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], `Replace with "-" or straight quotes: ${offenders.join(", ")}`);
  });
});
