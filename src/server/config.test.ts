import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { tempDir } from "../../test/helpers.ts";
import { expandHome, loadAppConfig, type ResolveInput, resolveWorkspace } from "./config.ts";
import { writeFileAtomic } from "./workspace/fsx.ts";

const home = resolve("/home/alex");
const base: ResolveInput = {
  env: {},
  home,
  cwd: resolve("/work"),
  config: {},
  configDir: join(home, ".config", "hirehound"),
};

describe("resolveWorkspace", () => {
  it("prefers the flag, then env, then config, then the default", () => {
    const all: ResolveInput = {
      ...base,
      flag: "flag-ws",
      env: { HIREHOUND_WORKSPACE: "~/env-ws" },
      config: { workspace: "~/config-ws" },
    };
    assert.deepEqual(resolveWorkspace(all), { path: resolve("/work/flag-ws"), source: "flag" });
    assert.deepEqual(resolveWorkspace({ ...all, flag: undefined }), {
      path: join(home, "env-ws"),
      source: "env",
    });
    assert.deepEqual(resolveWorkspace({ ...all, flag: undefined, env: {} }), {
      path: join(home, "config-ws"),
      source: "config",
    });
    assert.deepEqual(resolveWorkspace(base), {
      path: join(home, "Documents", "hirehound"),
      source: "default",
    });
  });

  it("resolves relative config paths against the config folder", () => {
    const result = resolveWorkspace({ ...base, config: { workspace: "../../data" } });
    assert.equal(result.path, join(home, "data"));
  });

  it("ignores blank values", () => {
    const result = resolveWorkspace({ ...base, flag: "  ", env: { HIREHOUND_WORKSPACE: "" } });
    assert.equal(result.source, "default");
  });
});

describe("expandHome", () => {
  it("expands ~ with either separator", () => {
    assert.equal(expandHome("~", home), home);
    assert.equal(expandHome("~/a", home), join(home, "a"));
    assert.equal(expandHome("~\\a", home), join(home, "a"));
    assert.equal(expandHome("a/~", home), "a/~");
  });
});

describe("loadAppConfig", () => {
  it("returns an empty config when the file is missing", async () => {
    const dir = await tempDir();
    try {
      assert.deepEqual(loadAppConfig(dir.path), {});
    } finally {
      await dir.cleanup();
    }
  });

  it("parses a valid file and rejects an invalid one", async () => {
    const dir = await tempDir();
    try {
      await writeFileAtomic(join(dir.path, "config.yaml"), "workspace: ~/ws\nport: 5000\n");
      assert.deepEqual(loadAppConfig(dir.path), { workspace: "~/ws", port: 5000 });
      await writeFileAtomic(join(dir.path, "config.yaml"), "port: not-a-number\n");
      assert.throws(() => loadAppConfig(dir.path), /Invalid .*config\.yaml: port/);
    } finally {
      await dir.cleanup();
    }
  });
});
