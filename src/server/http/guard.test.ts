import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRequest } from "./guard.ts";

const PORT = 4280;

describe("checkRequest", () => {
  it("allows the local app", () => {
    assert.equal(checkRequest("GET", { host: "127.0.0.1:4280" }, PORT), null);
    assert.equal(checkRequest("GET", { host: "localhost:4280" }, PORT), null);
    assert.equal(
      checkRequest(
        "POST",
        {
          host: "127.0.0.1:4280",
          origin: "http://127.0.0.1:4280",
          "sec-fetch-site": "same-origin",
        },
        PORT,
      ),
      null,
    );
  });

  it("allows non-browser clients without an Origin", () => {
    assert.equal(checkRequest("POST", { host: "127.0.0.1:4280" }, PORT), null);
  });

  it("blocks DNS rebinding through the Host header", () => {
    assert.match(checkRequest("GET", { host: "evil.example:4280" }, PORT) ?? "", /Host/);
    assert.match(checkRequest("GET", { host: "127.0.0.1:9999" }, PORT) ?? "", /Host/);
    assert.match(checkRequest("GET", {}, PORT) ?? "", /Host/);
  });

  it("blocks cross-origin requests", () => {
    const host = "127.0.0.1:4280";
    assert.ok(checkRequest("POST", { host, origin: "https://evil.example" }, PORT));
    assert.ok(checkRequest("GET", { host, origin: "null" }, PORT));
    assert.ok(checkRequest("POST", { host, origin: "https://127.0.0.1:4280" }, PORT));
    assert.ok(checkRequest("POST", { host, "sec-fetch-site": "cross-site" }, PORT));
  });
});
