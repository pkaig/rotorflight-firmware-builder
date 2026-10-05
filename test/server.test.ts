import { test, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("the app reports its version from package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const state = JSON.parse((await call("/api/state")).body) as { version: string };
  assert.match(state.version, /^\d+\.\d+\.\d+/);
  assert.equal(state.version, pkg.version);
});

test("the log is also written to app.log in the cache folder", async () => {
  await call("/api/rename-build", { method: "POST", headers: json, body: "{not json" }); // anything; the startup line is enough
  await new Promise((r) => setTimeout(r, 200));
  const text = readFileSync(join(process.env.RFB_CACHE_DIR!, "app.log"), "utf8");
  assert.match(text, /Rotorflight Firmware Builder \d+\.\d+\.\d+ started/);
});

test("a repository address that is not plain https is refused before git runs", async () => {
  const r = await call(`/api/remote-refs?repo=${encodeURIComponent("file:///C:/Windows")}`);
  assert.equal(r.status, 400);
  const load = await call("/api/load", { method: "POST", headers: json,
    body: JSON.stringify({ ref: "master", target: "STM32F405", repo: "git@github.com:a/b.git" }) });
  assert.equal(load.status, 400);
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
