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
  assert.deepEqual(lines, ["stdout:a", "stdout:b", "stderr:c"]);
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
