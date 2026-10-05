import { test } from "node:test";
import assert from "node:assert/strict";
import { exec } from "../src/exec.ts";
import { isBuildToolError } from "../src/errors.ts";

const NODE = process.execPath;

test("captures stdout and resolves with exit code 0", async () => {
  const r = await exec(NODE, ["-e", "process.stdout.write('hello')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "hello");
});

test("streams output one line at a time via onEvent", async () => {
  const lines: string[] = [];
  await exec(NODE, ["-e", "console.log('a'); console.log('b'); console.error('c')"], {
    onEvent: (e) => lines.push(`${e.stream}:${e.line}`),
  });
  // stdout and stderr are separate pipes, so only the order within each is guaranteed.
  assert.deepEqual(lines.filter((l) => l.startsWith("stdout:")), ["stdout:a", "stdout:b"]);
  assert.deepEqual(lines.filter((l) => l.startsWith("stderr:")), ["stderr:c"]);
});

test("non-zero exit rejects with BUILD_FAILED unless allowNonZero", async () => {
  await assert.rejects(
    () => exec(NODE, ["-e", "process.exit(3)"]),
    (e: unknown) => isBuildToolError(e) && e.code === "BUILD_FAILED",
  );
  const r = await exec(NODE, ["-e", "process.exit(3)"], { allowNonZero: true });
  assert.equal(r.code, 3);
});

// Point PATH at a directory that does not exist so the OS cannot resolve
// `git`/`make`. An absent PATH is not enough: libuv falls back to the parent
// process PATH on Windows. SystemRoot is kept so the Windows loader still works.
const BOGUS = process.platform === "win32" ? "C:\\rfb-no-such-dir" : "/rfb-no-such-dir";
const NO_PATH_ENV: NodeJS.ProcessEnv = {
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  PATH: BOGUS,
  Path: BOGUS,
};

test("missing git binary maps to GIT_NOT_FOUND", async () => {
  await assert.rejects(
    () => exec("git", ["--version"], { env: NO_PATH_ENV }),
    (e: unknown) => isBuildToolError(e) && e.code === "GIT_NOT_FOUND",
  );
});

test("missing make binary maps to MAKE_NOT_FOUND", async () => {
  await assert.rejects(
    () => exec("make", ["--version"], { env: NO_PATH_ENV }),
    (e: unknown) => isBuildToolError(e) && e.code === "MAKE_NOT_FOUND",
  );
});

test("finishes when the process exits even if a helper it started holds the output open", async () => {
  // The parent prints, starts a detached helper that inherits stdout and lives on,
  // then exits: the pipe stays open, as with an installer's background process.
  const parent = `
    const { spawn } = require("node:child_process");
    console.log("done");
    spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit", detached: true }).unref();
    process.exit(0);`;
  const t0 = Date.now();
  const r = await exec(NODE, ["-e", parent]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /done/);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
});

test("the child gets no stdin, so a prompt cannot wait forever", async () => {
  const r = await exec(NODE, ["-e", "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('eof'));"]);
  assert.match(r.stdout, /eof/);
});

test("a timeout stops the process and fails clearly", async () => {
  await assert.rejects(exec(NODE, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 500 }), /did not finish/);
});

test("lines redrawn with carriage returns report progress and keep their final state", async () => {
  const progress: string[] = [];
  const lines: string[] = [];
  await exec(NODE, ["-e", "process.stdout.write('10%\\r'); setTimeout(() => process.stdout.write('50%\\r100%\\nok\\n'), 100);"], {
    onProgress: (t) => progress.push(t),
    onEvent: (e) => lines.push(e.line),
  });
  assert.ok(progress.includes("10%"));
  assert.deepEqual(lines, ["100%", "ok"]);
});
