import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "../../../test/helpers.ts";
import { initWorkspace, inspectWorkspace } from "./init.ts";

describe("initWorkspace", () => {
  it("creates the layout and starter files", async () => {
    const dir = await tempDir();
    try {
      const root = join(dir.path, "ws");
      const { created } = await initWorkspace(root);
      assert.deepEqual(created.sort(), [
        "README.md",
        "hirehound.yaml",
        "profile/answers.yaml",
        "profile/contact.yaml",
        "profile/preferences.yaml",
      ]);
      const top = (await readdir(root)).sort();
      for (const name of ["jobs", "profile", "prompts", "sources", "templates"]) {
        assert.ok(top.includes(name), `missing ${name}`);
      }
      assert.ok((await readdir(join(root, "profile"))).includes("bases"));
      assert.equal(await inspectWorkspace(root), "workspace");
    } finally {
      await dir.cleanup();
    }
  });

  it("never overwrites existing files", async () => {
    const dir = await tempDir();
    try {
      const root = join(dir.path, "ws");
      await mkdir(join(root, "profile"), { recursive: true });
      await writeFile(join(root, "profile", "contact.yaml"), "name: Mine\n");
      const first = await initWorkspace(root);
      assert.ok(!first.created.includes("profile/contact.yaml"));
      assert.equal(await readFile(join(root, "profile", "contact.yaml"), "utf8"), "name: Mine\n");
      const second = await initWorkspace(root);
      assert.deepEqual(second.created, []);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("inspectWorkspace", () => {
  it("tells missing, empty and unrelated folders apart", async () => {
    const dir = await tempDir();
    try {
      assert.equal(await inspectWorkspace(join(dir.path, "nope")), "missing");
      const empty = join(dir.path, "empty");
      await mkdir(join(empty, ".git"), { recursive: true });
      assert.equal(await inspectWorkspace(empty), "empty");
      const other = join(dir.path, "other");
      await mkdir(other);
      await writeFile(join(other, "notes.txt"), "hello");
      assert.equal(await inspectWorkspace(other), "other");
      const legacy = join(dir.path, "legacy");
      await mkdir(join(legacy, "jobs"), { recursive: true });
      await mkdir(join(legacy, "profile"));
      assert.equal(await inspectWorkspace(legacy), "workspace");
    } finally {
      await dir.cleanup();
    }
  });
});
