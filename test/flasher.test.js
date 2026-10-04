import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flashDfu, mspFrame, pagesToErase, parseBoardInfo, parseFlashLayout, STATE,
} from "../app/flasher.js";

const F405 = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg";
const OPTION_BYTES = "@Option Bytes  /0x1FFFC000/01*016 e";
const BASE = 0x08000000;
const SIZE = 1024 * 1024;

/** A simulated STM32 ROM DfuSe bootloader with real NOR-flash rules. */
class FakeDfu {
  constructor({ corruptAt = -1, transferSize = 2048, noInterfaceNames = false } = {}) {
    this.mem = new Uint8Array(SIZE).fill(0x5a); // "old firmware" everywhere
    this.layout = parseFlashLayout(F405);
    this.state = STATE.dfuIDLE;
    this.pointer = BASE;
    this.pending = null;
    this.erased = [];
    this.left = false;
    this.corruptAt = corruptAt;
    this.transferSize = transferSize;
    this.configuration = {
      interfaces: [{
        interfaceNumber: 0,
        alternates: [
          // Windows Chrome leaves these empty for DFU alternates.
          { alternateSetting: 0, interfaceName: noInterfaceNames ? null : F405 },
          { alternateSetting: 1, interfaceName: noInterfaceNames ? null : OPTION_BYTES },
        ],
      }],
    };
  }
  async open() {} async close() {} async claimInterface() {} async selectConfiguration() {}
  async selectAlternateInterface() {}

  async controlTransferOut(setup, data) {
    const d = new Uint8Array(data);
    if (setup.request === 4) { this.state = STATE.dfuIDLE; return { status: "ok" }; } // CLRSTATUS
    assert.equal(setup.request, 1, "only DNLOAD/CLRSTATUS expected out");
    if (setup.value === 0 && d.length === 0) { this.left = true; this.pending = () => {}; }
    else if (setup.value === 0 && d[0] === 0x21) this.pending = () => { this.pointer = le(d); };
    else if (setup.value === 0 && d[0] === 0x41) {
      this.pending = () => {
        const a = le(d);
        const page = this.layout.pages.find((p) => p.address === a);
        assert.ok(page, `erase of a non-page address 0x${a.toString(16)}`);
        this.mem.fill(0xff, a - BASE, a - BASE + page.size);
        this.erased.push(a);
      };
    } else {
      const addr = this.pointer + (setup.value - 2) * this.transferSize;
      this.pending = () => {
        for (let i = 0; i < d.length; i++) {
          const o = addr - BASE + i;
          assert.equal(this.mem[o], 0xff, `write to un-erased flash at 0x${(addr + i).toString(16)}`);
          this.mem[o] = addr + i === this.corruptAt ? d[i] ^ 1 : d[i];
        }
      };
    }
    this.state = STATE.dfuDNBUSY;
    return { status: "ok" };
  }

  async controlTransferIn(setup, length) {
    if (setup.requestType === "standard") {
      const ts = this.transferSize;
      if (setup.value === 0x200) {
        // config(9) + interface alt 0 (string 4) + interface alt 1 (string 5) + DFU functional(9)
        const d = [9, 2, 36, 0, 1, 1, 0, 0x80, 50,
          9, 4, 0, 0, 0, 0xfe, 1, 2, 4,
          9, 4, 0, 1, 0, 0xfe, 1, 2, 5,
          9, 0x21, 0x0b, 0xff, 0, ts & 0xff, ts >> 8, 0x1a, 1];
        return ok(d.slice(0, length));
      }
      if (setup.value === 0x300) return ok([4, 3, 0x09, 0x04]);
      const str = { 0x304: F405, 0x305: OPTION_BYTES }[setup.value];
      if (str) return ok([2 + str.length * 2, 3, ...[...str].flatMap((c) => [c.charCodeAt(0), 0])]);
      throw new Error(`unexpected descriptor request 0x${setup.value.toString(16)}`);
    }
    if (setup.request === 3) { // GETSTATUS
      if (this.state === STATE.dfuDNBUSY && this.pending) {
        const op = this.pending; this.pending = null; op();
        return ok([0, 1, 0, 0, STATE.dfuDNBUSY, 0]);
      }
      if (this.state === STATE.dfuDNBUSY) this.state = STATE.dfuDNLOAD_IDLE;
      return ok([0, 0, 0, 0, this.state, 0]);
    }
    if (setup.request === 2) { // UPLOAD
      const addr = this.pointer + (setup.value - 2) * this.transferSize;
      this.state = STATE.dfuUPLOAD_IDLE;
      return ok(this.mem.slice(addr - BASE, addr - BASE + length));
    }
    throw new Error(`unexpected IN request ${setup.request}`);
  }
}
const le = (d) => (d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0;
const ok = (bytes) => { const u = Uint8Array.from(bytes); return { status: "ok", data: new DataView(u.buffer) }; };

function image() {
  const block = (address, n, seed) => ({ address, data: Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff) });
  return {
    blocks: [
      block(0x08000000, 392, 1),        // vectors
      block(0x08002800, 8, 2),          // custom-defaults pointers
      block(0x08002808, 2237, 3),       // inserted board config
      block(0x08008000, 300000, 4),     // firmware, spans 64K + 128K sectors
    ],
  };
}

test("parses the F405 DFU flash layout", () => {
  const l = parseFlashLayout(F405);
  assert.equal(l.pages.length, 12);
  assert.deepEqual(l.pages.slice(0, 5).map((p) => p.size / 1024), [16, 16, 16, 16, 64]);
  assert.equal(l.pages[11].address, 0x080e0000);
});

test("erases only touched sectors, leaving the settings sector alone", () => {
  const pages = pagesToErase(parseFlashLayout(F405), image().blocks).map((p) => p.address.toString(16));
  // 0x08004000 (16K) is FLASH_CONFIG: the board's settings must survive a flash.
  assert.deepEqual(pages, ["8000000", "8008000", "800c000", "8010000", "8020000", "8040000"]);
});

test("flashes, verifies and leaves DFU on a simulated STM32", async () => {
  const dev = new FakeDfu();
  const img = image();
  const stages = new Set();
  await flashDfu(dev, img, { onProgress: (s) => stages.add(s) });
  for (const b of img.blocks) {
    assert.deepEqual(dev.mem.subarray(b.address - BASE, b.address - BASE + b.data.length), b.data);
  }
  assert.equal(dev.mem[0x4000], 0x5a, "settings sector untouched");
  assert.ok(dev.left, "left DFU");
  assert.deepEqual([...stages], ["erase", "write", "verify", "done"]);
});

test("finds the flash region from raw descriptors when the browser gives no interface names (Windows)", async () => {
  const dev = new FakeDfu({ noInterfaceNames: true });
  const img = image();
  const logs = [];
  await flashDfu(dev, img, { onLog: (l) => logs.push(l) });
  assert.ok(logs.some((l) => /^DFU: @Internal Flash/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => /^Memory regions: @Internal Flash.*\| @Option Bytes/.test(l)), "lists the regions it found");
  for (const b of img.blocks) {
    assert.deepEqual(dev.mem.subarray(b.address - BASE, b.address - BASE + b.data.length), b.data);
  }
  assert.ok(dev.left);
});

test("honours a non-default DFU transfer size", async () => {
  const dev = new FakeDfu({ transferSize: 1024 });
  const img = image();
  await flashDfu(dev, img);
  const b = img.blocks[3];
  assert.deepEqual(dev.mem.subarray(b.address - BASE, b.address - BASE + b.data.length), b.data);
});

test("a corrupted write is caught by verify and DFU is not left", async () => {
  const dev = new FakeDfu({ corruptAt: 0x08010123 });
  await assert.rejects(flashDfu(dev, image()), /Verify failed at 0x8010123/);
  assert.equal(dev.left, false);
});

test("refuses an image outside the chip's flash", async () => {
  const dev = new FakeDfu();
  await assert.rejects(flashDfu(dev, { blocks: [{ address: 0x08200000, data: new Uint8Array(4) }] }), /outside this chip's flash/);
});

test("MSP frames carry a payload checksum; board info exposes the flash-bootloader bit", () => {
  assert.deepEqual([...mspFrame(68, [1])], [0x24, 0x4d, 0x3c, 1, 68, 1, 1 ^ 68 ^ 1]);
  const enc = (s) => [s.length, ...Buffer.from(s)];
  const d = [...Buffer.from("S405"), 0, 0, 2, 0b1000, ...enc("STM32F405"), ...enc("NEXUS"), ...enc("RTFL"), ...enc("RDMS")];
  const info = parseBoardInfo(Uint8Array.from(d));
  assert.equal(info.targetName, "STM32F405");
  assert.equal(info.manufacturerId, "RDMS");
  assert.equal(info.hasFlashBootloader, true);
});
