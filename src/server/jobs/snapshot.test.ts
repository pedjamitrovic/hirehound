import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { HttpError } from "../http/router.ts";
import { fetchPosting, normalizePostingText, SnapshotCache, textSha256 } from "./snapshot.ts";

const LONG = "We build reliable infrastructure for robots. ".repeat(12);

const PAGES: Record<string, { status?: number; type?: string; body: string | Buffer }> = {
  "/job": {
    body: `<html><head><title>Platform Lead - Acme</title>
      <meta property="og:site_name" content="Acme"></head>
      <body><nav>Menu</nav><main><h1>Platform Lead</h1><p>${LONG}</p></main></body></html>`,
  },
  "/latin1": {
    type: "text/html; charset=iso-8859-1",
    body: Buffer.from(
      `<html><body><main><p>Z\u00fcrich office. ${LONG}</p></main></body></html>`,
      "latin1",
    ),
  },
  "/spa": {
    body: `<html><head><title>Loading</title></head><body><div id="root"></div></body></html>`,
  },
  "/forbidden": { status: 403, body: "no" },
  "/gone": { status: 404, body: "no" },
  "/pdf": { type: "application/pdf", body: "%PDF-1.7" },
  "/big": { body: `<p>${"x".repeat(5000)}</p>` },
};

describe("fetchPosting", () => {
  let server: Server;
  let base = "";

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/job" });
        res.end();
        return;
      }
      const page = PAGES[req.url ?? ""];
      if (!page) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(page.status ?? 200, {
        "content-type": page.type ?? "text/html; charset=utf-8",
      });
      res.end(page.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("extracts metadata and readable text", async () => {
    const snapshot = await fetchPosting(`${base}/job`);
    assert.equal(snapshot.extracted.company, "Acme");
    assert.equal(snapshot.extracted.title, "Platform Lead");
    assert.match(snapshot.text, /^## Platform Lead\n\nWe build reliable/);
    assert.doesNotMatch(snapshot.text, /Menu/);
    assert.deepEqual(snapshot.warnings, []);
    assert.match(snapshot.html, /<nav>Menu<\/nav>/);
  });

  it("follows redirects and records the final URL", async () => {
    const snapshot = await fetchPosting(`${base}/redirect`);
    assert.equal(snapshot.url, `${base}/redirect`);
    assert.equal(snapshot.finalUrl, `${base}/job`);
  });

  it("decodes the declared charset", async () => {
    const snapshot = await fetchPosting(`${base}/latin1`);
    assert.match(snapshot.text, /Z\u00fcrich office/);
  });

  it("warns when a page has almost no text", async () => {
    const snapshot = await fetchPosting(`${base}/spa`);
    assert.match(snapshot.warnings.join(" "), /JavaScript/);
  });

  it("explains refusals, missing pages and non-HTML links", async () => {
    await assert.rejects(fetchPosting(`${base}/forbidden`), (error: HttpError) => {
      assert.equal(error.status, 422);
      assert.match(error.message, /refused the request \(403\)/);
      return true;
    });
    await assert.rejects(fetchPosting(`${base}/gone`), /taken down/);
    await assert.rejects(fetchPosting(`${base}/pdf`), /not a web page \(application\/pdf\)/);
  });

  it("enforces the size limit", async () => {
    await assert.rejects(fetchPosting(`${base}/big`, { maxBytes: 1000 }), /too large/);
  });

  it("reports unreachable hosts", async () => {
    const failing: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await assert.rejects(
      fetchPosting("https://unreachable.example/job", { fetchImpl: failing }),
      /Could not reach unreachable\.example/,
    );
  });
});

describe("SnapshotCache", () => {
  it("stores, reads and deletes by token, and evicts the oldest", async () => {
    const cache = new SnapshotCache(60_000, 2);
    const snapshot = await Promise.resolve({
      url: "u",
      finalUrl: "u",
      fetchedAt: "t",
      html: "",
      text: "",
      warnings: [],
      extracted: {
        title: null,
        company: null,
        location: null,
        workplace: "unknown" as const,
        employmentType: "unknown" as const,
        salary: null,
        postedAt: null,
        validThrough: null,
        description: null,
        sourceRef: null,
      },
    });
    const a = cache.put(snapshot);
    const b = cache.put(snapshot);
    const c = cache.put(snapshot);
    assert.equal(cache.get(a), undefined);
    assert.equal(cache.get(b), snapshot);
    cache.delete(b);
    assert.equal(cache.get(b), undefined);
    assert.equal(cache.get(c), snapshot);
  });

  it("expires entries", () => {
    const cache = new SnapshotCache(-1);
    const token = cache.put({} as never);
    assert.equal(cache.get(token), undefined);
  });
});

describe("text helpers", () => {
  it("hashes text independent of whitespace and case", () => {
    assert.equal(textSha256("Hello   World\n"), textSha256("hello world"));
    assert.notEqual(textSha256("hello world"), textSha256("hello there"));
  });

  it("normalises pasted text", () => {
    assert.equal(normalizePostingText("  a  \r\n\r\n\r\n\r\nb\t\n"), "a\n\nb");
  });
});
