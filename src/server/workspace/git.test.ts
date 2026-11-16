import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "../../../test/helpers.ts";
import { detectGit, gitDiagnostics, parseRemotes } from "./git.ts";

describe("parseRemotes", () => {
  it("reads remote sections only", () => {
    const config = [
      "[core]",
      "\turl = not-a-remote",
      '[remote "origin"]',
      "\turl = git@github.com:alex/jobs.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      '[branch "main"]',
      "\tremote = origin",
      '[remote "backup"]',
      "  url = https://example.com/backup.git",
    ].join("\n");
    assert.deepEqual(parseRemotes(config), [
      { name: "origin", url: "git@github.com:alex/jobs.git" },
      { name: "backup", url: "https://example.com/backup.git" },
    ]);
  });
});

describe("detectGit", () => {
  it("finds the enclosing repo and flags the Hirehound repo itself", async () => {
    const dir = await tempDir();
    try {
      const repo = join(dir.path, "repo");
      await mkdir(join(repo, ".git"), { recursive: true });
      await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://x/y.git\n');
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: "hirehound" }));
      const ws = join(repo, "workspace");
      await mkdir(ws);
      const git = await detectGit(ws);
      assert.equal(git?.root, repo);
      assert.equal(git?.insideToolRepo, true);
      assert.equal(gitDiagnostics(git)[0]?.severity, "error");
    } finally {
      await dir.cleanup();
    }
  });

  it("warns about remotes and stays quiet for local-only repos", () => {
    assert.deepEqual(gitDiagnostics(null), []);
    assert.deepEqual(gitDiagnostics({ root: "/r", remotes: [], insideToolRepo: false }), []);
    const warning = gitDiagnostics({
      root: "/r",
      remotes: [{ name: "origin", url: "https://github.com/a/b" }],
      insideToolRepo: false,
    });
    assert.equal(warning[0]?.severity, "warning");
    assert.match(warning[0]?.message ?? "", /private/);
  });
});
