// Browser-side board access for the app page: MSP over Web Serial (detect,
// reboot to bootloader) and STM32 DfuSe flashing over WebUSB. The DFU sequence
// mirrors the Rotorflight Configurator's (src/js/protocols/stm32usbdfu.js):
// erase only the touched sectors, write, read back and compare, then leave DFU.
// Kept free of DOM access so it can be exercised in Node against a fake device.

// --- MSP v1 ---------------------------------------------------------------------------

export const MSP_FC_VERSION = 3;
export const MSP_BOARD_INFO = 4;
export const MSP_SET_REBOOT = 68;
export const REBOOT_BOOTLOADER_ROM = 1;
export const REBOOT_BOOTLOADER_FLASH = 4;

export function mspFrame(cmd, payload = []) {
  // "$M<" size cmd payload checksum (xor of size, cmd, payload)
  let crc = payload.length ^ cmd;
  for (const b of payload) crc ^= b;
  return new Uint8Array([0x24, 0x4d, 0x3c, payload.length, cmd, ...payload, crc]);
}

/** Request/response over a Web Serial reader+writer, keeping a buffer across calls. */
export function mspClient(reader, writer) {
  let buf = new Uint8Array(0);
  const take = () => {
    for (let i = 0; i + 5 < buf.length; i++) {
      if (buf[i] !== 0x24 || buf[i + 1] !== 0x4d || (buf[i + 2] !== 0x3e && buf[i + 2] !== 0x21)) continue;
      let size = buf[i + 3], off = i + 5;
      const cmd = buf[i + 4];
      if (size === 255) { if (i + 7 >= buf.length) return; size = buf[i + 5] | (buf[i + 6] << 8); off = i + 7; }
      if (off + size >= buf.length) return; // incomplete
      let crc = 0;
      for (let j = i + 3; j < off + size; j++) crc ^= buf[j];
      const frame = { ok: buf[i + 2] === 0x3e && crc === buf[off + size], cmd, data: buf.slice(off, off + size) };
      buf = buf.slice(off + size + 1);
      return frame;
    }
  };
  // One outstanding read at a time: a read abandoned by a timeout must be
  // reused, or the chunk it eventually resolves with is lost.
  let pending;
  return async function request(cmd, timeoutMs = 2000, payload = []) {
    await writer.write(mspFrame(cmd, payload));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let frame;
      while ((frame = take())) if (frame.cmd === cmd) {
        if (!frame.ok) throw new Error(`MSP command ${cmd} was rejected`);
        return frame.data;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no MSP reply — is the board running Rotorflight (not in DFU/bootloader)?");
      let timer;
      pending ??= reader.read();
      const chunk = await Promise.race([pending, new Promise((r) => (timer = setTimeout(() => r({ timeout: true }), left)))]);
      clearTimeout(timer);
      if (!chunk.timeout) pending = undefined;
      if (chunk.done) throw new Error("serial port closed");
      if (chunk.value) { const n = new Uint8Array(buf.length + chunk.value.length); n.set(buf); n.set(chunk.value, buf.length); buf = n; }
    }
  };
}

export function parseBoardInfo(d) {
  let i = 0;
  const str = (n) => { let s = ""; for (const end = i + n; i < end && i < d.length; i++) s += String.fromCharCode(d[i]); return s; };
  const lstr = () => (i < d.length ? str(d[i++]) : "");
  const boardIdentifier = str(4);
  i += 3; // boardVersion u16, boardType u8
  const capabilities = d[i++] ?? 0;
  const targetName = lstr(), boardName = lstr(), boardDesign = lstr(), manufacturerId = lstr();
  return {
    boardIdentifier, targetName, boardName, boardDesign, manufacturerId, capabilities,
    hasFlashBootloader: Boolean(capabilities & (1 << 3)),
  };
}

/** Open a granted serial port, run fn(request), always close. */
export async function withMsp(port, fn) {
  let reader, writer;
  try {
    await port.open({ baudRate: 115200 });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    return await fn(mspClient(reader, writer));
  } finally {
    try { await reader?.cancel(); } catch {}
    reader?.releaseLock(); writer?.releaseLock();
    try { await port.close(); } catch {}
  }
}

/** Read board info, then ask the firmware to reboot into its bootloader (DFU). */
export async function rebootToBootloader(port) {
  return withMsp(port, async (request) => {
    const info = parseBoardInfo(await request(MSP_BOARD_INFO));
    const mode = info.hasFlashBootloader ? REBOOT_BOOTLOADER_FLASH : REBOOT_BOOTLOADER_ROM;
    // The board resets as soon as it handles this, so a missing reply is normal.
    try { await request(MSP_SET_REBOOT, 500, [mode]); } catch {}
    return info;
  });
}

// --- DfuSe over WebUSB ------------------------------------------------------------------

export const DFU_FILTER = { vendorId: 0x0483, productId: 0xdf11 };
const REQ = { DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4 };
export const STATE = { dfuIDLE: 2, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WebUSB calls have no timeout of their own: turn a hang into an error that says where. */
export const USB_TIMEOUT_MS = 10000;
function timed(promise, what, ms = USB_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))),
  ]).finally(() => clearTimeout(timer));
}
const REQ_NAME = { 1: "DNLOAD", 2: "UPLOAD", 3: "GETSTATUS", 4: "CLRSTATUS" };

/** "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg" -> page list. */
export function parseFlashLayout(name) {
  const parts = name.replace(/[^\x20-\x7E]+/g, "").split("/");
  if (parts.length < 3 || !parts[0].startsWith("@")) return null;
  const start = parseInt(parts[1]);
  const pages = [];
  let addr = start;
  for (const seg of parts[2].split(",")) {
    const m = seg.trim().match(/^(\d+)\*(\d+)\s*([KM]?)/);
    if (!m) return null;
    const size = parseInt(m[2]) * (m[3] === "M" ? 1024 * 1024 : m[3] === "K" ? 1024 : 1);
    for (let i = 0; i < parseInt(m[1]); i++, addr += size) pages.push({ address: addr, size });
  }
  return { type: parts[0].slice(1).trim(), start, pages };
}

/** Pages a set of blocks touches (the Configurator's "local erase"). */
export function pagesToErase(layout, blocks) {
  return layout.pages.filter((p) =>
    blocks.some((b) => b.address < p.address + p.size && b.address + b.data.length > p.address));
}

export class DfuSe {
  constructor(device, iface) {
    this.device = device;
    this.iface = iface;
    this.transferSize = 2048;
  }

  async out(request, value, data) {
    const r = await timed(this.device.controlTransferOut(
      { requestType: "class", recipient: "interface", request, value, index: this.iface },
      data ? new Uint8Array(data) : new ArrayBuffer(0)), `DFU ${REQ_NAME[request]}`);
    if (r.status !== "ok") throw new Error(`DFU ${REQ_NAME[request]} failed (${r.status})`);
  }

  async in(request, value, length) {
    const r = await timed(this.device.controlTransferIn(
      { requestType: "class", recipient: "interface", request, value, index: this.iface }, length), `DFU ${REQ_NAME[request]}`);
    if (r.status !== "ok") throw new Error(`DFU ${REQ_NAME[request]} failed (${r.status})`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async status() {
    const d = await this.in(REQ.GETSTATUS, 0, 6);
    return { status: d[0], poll: d[1] | (d[2] << 8) | (d[3] << 16), state: d[4] };
  }

  /** Back to dfuIDLE, the way the Configurator does it. */
  async clearStatus() {
    for (let i = 0; i < 20; i++) {
      const s = await this.status();
      if (s.state === STATE.dfuIDLE) return;
      await sleep(s.poll);
      await this.out(REQ.CLRSTATUS, 0);
    }
    throw new Error("DFU device would not return to idle");
  }

  /** Wait out dfuDNBUSY after a download request; must end in dfuDNLOAD_IDLE. */
  async settle(what, { eraseQuirk = false } = {}) {
    let s = await this.status();
    if (s.state === STATE.dfuDNBUSY) {
      await sleep(s.poll);
      s = await this.status();
      // H743 rev V stays busy after the advertised delay; STM32CubeProgrammer
      // and the Configurator clear status twice and treat the erase as done.
      if (s.state === STATE.dfuDNBUSY && eraseQuirk) {
        await this.clearStatus();
        return;
      }
    }
    if (s.state !== STATE.dfuDNLOAD_IDLE) throw new Error(`${what} failed (DFU state ${s.state}, status ${s.status})`);
  }

  async command(bytes, what, opts) {
    await this.out(REQ.DNLOAD, 0, bytes);
    await this.settle(what, opts);
  }

  setAddress(a) {
    return this.command([0x21, a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, (a >>> 24) & 0xff], `Set address 0x${a.toString(16)}`);
  }

  erasePage(a) {
    return this.command([0x41, a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, (a >>> 24) & 0xff], `Erase 0x${a.toString(16)}`, { eraseQuirk: true });
  }
}

const GET_DESCRIPTOR = (value, index = 0) => ({ requestType: "standard", recipient: "device", request: 6, value, index });

async function readString(device, index, langId) {
  if (!index) return "";
  const r = await device.controlTransferIn(GET_DESCRIPTOR(0x300 | index, langId), 255);
  if (r.status !== "ok") throw new Error(`USB string descriptor ${index}: ${r.status}`);
  const len = Math.min(r.data.getUint8(0), r.data.byteLength);
  let s = "";
  for (let i = 2; i + 1 < len; i += 2) s += String.fromCodePoint(r.data.getUint16(i, true));
  return s;
}

/**
 * Read the DFU interface's alternate settings and transfer size from the raw
 * USB descriptors. WebUSB does not reliably fill in
 * USBAlternateInterface.interfaceName for a DFU device's alternates (it comes
 * back empty on Windows), so — like the Configurator — fetch the configuration
 * descriptor and each alternate's string descriptor directly.
 */
export async function readDfuDescriptors(device) {
  const head = await device.controlTransferIn(GET_DESCRIPTOR(0x200), 9);
  if (head.status !== "ok") throw new Error(`USB configuration descriptor: ${head.status}`);
  const total = head.data.getUint16(2, true);
  const full = await device.controlTransferIn(GET_DESCRIPTOR(0x200), total);
  if (full.status !== "ok") throw new Error(`USB configuration descriptor: ${full.status}`);
  const d = new Uint8Array(full.data.buffer, full.data.byteOffset, full.data.byteLength);

  let langId = 0x0409;
  try {
    const l = await device.controlTransferIn(GET_DESCRIPTOR(0x300), 255);
    if (l.status === "ok" && l.data.byteLength >= 4) langId = l.data.getUint16(2, true);
  } catch {}

  const alternates = [];
  let transferSize = 2048;
  for (let o = d[0] || 9; o + 1 < d.length; o += d[o] || 1) {
    const type = d[o + 1];
    if (type === 4) { // interface descriptor
      alternates.push({ interfaceNumber: d[o + 2], alternateSetting: d[o + 3], name: await readString(device, d[o + 8], langId) });
    } else if (type === 0x21 && d[o] >= 7) { // DFU functional descriptor
      transferSize = d[o + 5] | (d[o + 6] << 8);
    }
  }
  return { alternates, transferSize };
}

/**
 * Flash an image ({ blocks: [{ address, data: Uint8Array }] }) to an STM32 in
 * DFU mode. onProgress(stage, fraction) and onLog(line) report as it goes.
 */
export async function flashDfu(device, image, { onProgress = () => {}, onLog = () => {} } = {}) {
  const id = `${(device.vendorId ?? 0).toString(16).padStart(4, "0")}:${(device.productId ?? 0).toString(16).padStart(4, "0")}`;
  onLog(`Opening USB device ${device.productName || "(unnamed)"} ${id}…`);
  try {
    await timed(device.open(), "Opening the USB device");
  } catch (err) {
    throw new Error(`Could not open the DFU device (${err.message}). On Windows it needs the WinUSB driver, and no other program (Configurator, STM32CubeProgrammer) may have it open`);
  }
  try {
    if (!device.configuration) await timed(device.selectConfiguration(1), "Selecting the USB configuration");
    onLog("Reading the DFU descriptors…");
    const desc = await timed(readDfuDescriptors(device), "Reading the DFU descriptors");
    // Prefer the names read from the descriptors; the browser's own may be empty.
    const named = desc.alternates.map((a) => ({
      ...a,
      name: (a.name || device.configuration.interfaces
        .find((i) => i.interfaceNumber === a.interfaceNumber)?.alternates
        .find((x) => x.alternateSetting === a.alternateSetting)?.interfaceName || "").replace(/[^\x20-\x7E]+/g, "").trim(),
    }));
    const alt = named.find((a) => /^@Internal Flash/.test(a.name));
    if (!alt) {
      const seen = named.map((a) => `"${a.name || "(no name)"}"`).join(", ") || "none";
      throw new Error(`This DFU device does not expose an '@Internal Flash' region (found: ${seen}).`);
    }
    onLog(`Memory regions: ${named.map((a) => a.name || "(no name)").join(" | ")}`);
    const layout = parseFlashLayout(alt.name);
    if (!layout) throw new Error(`Cannot parse flash layout "${alt.name}".`);
    onLog(`Claiming interface ${alt.interfaceNumber}, alternate ${alt.alternateSetting}…`);
    await timed(device.claimInterface(alt.interfaceNumber), "Claiming the DFU interface");
    if (alt.alternateSetting !== 0) await timed(device.selectAlternateInterface(alt.interfaceNumber, alt.alternateSetting), "Selecting the flash alternate");

    const dfu = new DfuSe(device, alt.interfaceNumber);
    dfu.transferSize = desc.transferSize || 2048;
    onLog(`DFU: ${alt.name}, transfer size ${dfu.transferSize}`);

    const outside = image.blocks.find((b) => b.address < layout.start ||
      b.address + b.data.length > layout.start + layout.pages.reduce((n, p) => n + p.size, 0));
    if (outside) throw new Error(`Image block at 0x${outside.address.toString(16)} is outside this chip's flash.`);

    const st = await dfu.status();
    onLog(`DFU status ${st.status}, state ${st.state}; flash ${(layout.pages.reduce((n, p) => n + p.size, 0) / 1024).toFixed(0)} KB at 0x${layout.start.toString(16)}.`);
    await dfu.clearStatus();

    const pages = pagesToErase(layout, image.blocks);
    onLog(`Erasing ${pages.length} sector(s), ${(pages.reduce((n, p) => n + p.size, 0) / 1024).toFixed(0)} KB…`);
    for (const [n, p] of pages.entries()) {
      try {
        await dfu.erasePage(p.address);
      } catch (err) {
        throw new Error(`${err.message}. If the chip is read-protected, flash once with the Rotorflight Configurator to unprotect it.`);
      }
      onProgress("erase", (n + 1) / pages.length);
    }

    const total = image.blocks.reduce((n, b) => n + b.data.length, 0);
    let done = 0;
    onLog(`Writing ${total.toLocaleString()} bytes…`);
    for (const b of image.blocks) {
      await dfu.setAddress(b.address);
      for (let off = 0, block = 2; off < b.data.length; off += dfu.transferSize, block++) {
        const chunk = b.data.subarray(off, off + dfu.transferSize);
        await dfu.out(REQ.DNLOAD, block, chunk);
        await dfu.settle(`Write 0x${(b.address + off).toString(16)}`);
        done += chunk.length;
        onProgress("write", done / total);
      }
    }

    onLog("Verifying…");
    done = 0;
    for (const b of image.blocks) {
      await dfu.clearStatus();
      await dfu.setAddress(b.address);
      await dfu.clearStatus();
      for (let off = 0, block = 2; off < b.data.length; off += dfu.transferSize, block++) {
        const want = b.data.subarray(off, off + dfu.transferSize);
        const got = await dfu.in(REQ.UPLOAD, block, want.length);
        for (let i = 0; i < want.length; i++) {
          if (got[i] !== want[i]) throw new Error(`Verify failed at 0x${(b.address + off + i).toString(16)}: wrote ${want[i]}, read ${got[i]}.`);
        }
        done += want.length;
        onProgress("verify", done / total);
      }
    }
    onLog("Verified. Leaving DFU, the board will restart…");

    await dfu.clearStatus();
    await dfu.setAddress(image.blocks[0].address);
    await dfu.out(REQ.DNLOAD, 0);
    try { await dfu.status(); } catch {} // the device resets here
    onProgress("done", 1);
  } finally {
    try { await device.close(); } catch {}
  }
}
