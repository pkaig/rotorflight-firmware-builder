import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the server's cache and output out of the user's real folders.
const scratch = mkdtempSync(join(tmpdir(), "rfb-test-"));
process.env.RFB_CACHE_DIR = join(scratch, "cache");
process.env.RFB_OUTPUT_DIR = join(scratch, "out");
const { startServer } = await import("../src/app/server.ts");
const server = await startServer({ port: 0 });
after(() => {
  server.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** node:http rather than fetch, so the Host header can be set freely. */
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.port, path, method: opts.method ?? "GET", headers: { host: `localhost:${server.port}`, ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const json = { "content-type": "application/json" };

test("the page's own requests are served", async () => {
  assert.equal((await call("/api/state")).status, 200);
  const r = await call("/api/rename-build", { method: "POST", headers: json, body: JSON.stringify({ at: "nope" }) });
  assert.equal(r.status, 404); // reached the handler: no such build
});

test("a foreign Host header (DNS rebinding) is refused", async () => {
  const r = await call("/api/dirs", { headers: { host: `attacker.example:${server.port}` } });
  assert.equal(r.status, 403);
});

test("a cross-site form-style POST is refused before it is parsed", async () => {
  const plain = await call("/api/build", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 403);
  const foreign = await call("/api/build", { method: "POST", headers: { ...json, origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
});

test("malformed JSON is a 400, not a 500", async () => {
  const r = await call("/api/rename-build", { method: "POST", headers: json, body: "{not json" });
  assert.equal(r.status, 400);
  assert.match(r.body, /not valid JSON/);
});
