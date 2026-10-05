import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256File, toolchainUrl, TOOLCHAIN_SHA256 } from "../src/download.ts";

const TOOLS_MK = `ARM_SDK_URL_BASE  := https://developer.arm.com/-/media/Files/downloads/gnu-rm/9-2020q2/gcc-arm-none-eabi-9-2020-q2-update

ifeq ($(OSFAMILY), linux)
  ARM_SDK_URL  := $(ARM_SDK_URL_BASE)-x86_64-linux.tar.bz2
endif

ifeq ($(OSFAMILY), macosx)
  ARM_SDK_URL  := $(ARM_SDK_URL_BASE)-mac.tar.bz2
endif

ifeq ($(OSFAMILY), windows)
  ARM_SDK_URL  := $(ARM_SDK_URL_BASE)-win32.zip
endif
`;

test("derives this OS's toolchain archive URL from tools.mk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rfb-dl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "make"));
  await writeFile(join(dir, "make", "tools.mk"), TOOLS_MK);
  const url = await toolchainUrl(dir);
  const suffix = process.platform === "win32" ? "-win32.zip" : process.platform === "darwin" ? "-mac.tar.bz2" : "-x86_64-linux.tar.bz2";
  assert.equal(url, `https://developer.arm.com/-/media/Files/downloads/gnu-rm/9-2020q2/gcc-arm-none-eabi-9-2020-q2-update${suffix}`);
});

test("pins checksums for the Windows and Linux 9-2020-q2 archives", () => {
  assert.match(TOOLCHAIN_SHA256["gcc-arm-none-eabi-9-2020-q2-update-win32.zip"]!, /^[0-9a-f]{64}$/);
  assert.match(TOOLCHAIN_SHA256["gcc-arm-none-eabi-9-2020-q2-update-x86_64-linux.tar.bz2"]!, /^[0-9a-f]{64}$/);
});

test("sha256File hashes a file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rfb-dl-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "x"), "abc");
  assert.equal(await sha256File(join(dir, "x")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("toolchainEnv puts the toolchain first on PATH, whatever the key's spelling", async () => {
  const { toolchainEnv } = await import("../src/toolchain.ts");
  const sep = process.platform === "win32" ? ";" : ":";
  assert.equal(toolchainEnv("/tc/bin", { PATH: "/usr/bin" }).PATH, `/tc/bin${sep}/usr/bin`);
  const win = toolchainEnv("C:\\tc\\bin", { Path: "C:\\Windows" });
  assert.deepEqual(Object.keys(win), ["Path"]); // no second PATH key
  assert.equal(win.Path, `C:\\tc\\bin${sep}C:\\Windows`);
  assert.equal(toolchainEnv("/tc/bin", {}).PATH, "/tc/bin");
});
