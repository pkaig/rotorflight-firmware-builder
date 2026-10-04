import { BuildToolError } from "./errors.ts";

/**
 * Intel HEX parsing and board-config insertion, mirroring what the Rotorflight
 * Configurator's flasher does (src/js/workers/hex_parser.js and
 * src/js/ConfigInserter.js), so a firmware flashed from the sample app is
 * byte-identical to one flashed through the Configurator.
 */

export interface HexBlock {
  address: number;
  data: Uint8Array;
}

export interface FirmwareImage {
  blocks: HexBlock[];
  bytesTotal: number;
}

/** Parse Intel HEX into contiguous blocks. Rejects checksum errors and a missing EOF record. */
export function parseHex(text: string): FirmwareImage {
  const blocks: { address: number; bytes: number[] }[] = [];
  let base = 0;
  let next = 0;
  let eof = false;
  let total = 0;

  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith(":")) throw new BuildToolError("INVALID_ARGS", `HEX line ${n + 1} does not start with ':'.`);
    const bytes = Buffer.from(line.slice(1), "hex");
    const count = bytes[0]!;
    if (bytes.length !== count + 5) throw new BuildToolError("INVALID_ARGS", `HEX line ${n + 1} has the wrong length.`);
    if (bytes.reduce((a, b) => (a + b) & 0xff, 0) !== 0) {
      throw new BuildToolError("INVALID_ARGS", `HEX line ${n + 1} fails its checksum.`);
    }
    const offset = (bytes[1]! << 8) | bytes[2]!;
    const type = bytes[3]!;
    const payload = bytes.subarray(4, 4 + count);

    if (type === 0x00) {
      // Same block-splitting rule as the Configurator: a new block whenever the
      // address is not contiguous (or restarts at 0 in a new 64K segment).
      if (offset !== next || next === 0) blocks.push({ address: base + offset, bytes: [] });
      next = offset + count;
      blocks[blocks.length - 1]!.bytes.push(...payload);
      total += count;
    } else if (type === 0x01) {
      eof = true;
    } else if (type === 0x04) {
      base = ((payload[0]! << 24) | (payload[1]! << 16)) >>> 0;
    }
  }
  if (!eof) throw new BuildToolError("INVALID_ARGS", "HEX file has no end-of-file record.");
  return { blocks: blocks.map((b) => ({ address: b.address, data: Uint8Array.from(b.bytes) })), bytesTotal: total };
}

/** Where unified-target firmware keeps the pointers to its custom-defaults area. */
const CUSTOM_DEFAULTS_POINTER_ADDRESS = 0x08002800;
const INSERT_BLOCK = 16384;

function readU32(image: FirmwareImage, address: number): number | undefined {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const a = address + i;
    const b = image.blocks.find((x) => a >= x.address && a < x.address + x.data.length);
    if (!b) return undefined;
    v |= b.data[a - b.address]! << (8 * i);
  }
  return v >>> 0;
}

/**
 * Insert a board config into the firmware's custom-defaults area, as the
 * Configurator's ConfigInserter does. Returns false when the firmware has no
 * such area (a non-unified build), and throws if it is too small or occupied.
 */
export function insertConfig(image: FirmwareImage, config: string): boolean {
  const start = readU32(image, CUSTOM_DEFAULTS_POINTER_ADDRESS);
  const end = readU32(image, CUSTOM_DEFAULTS_POINTER_ADDRESS + 4);
  if (start === undefined || end === undefined || end === start) return false;
  const text = Buffer.from(`${config}\0`, "latin1");
  if (text.length > end - start) {
    throw new BuildToolError(
      "INVALID_ARGS",
      `Custom defaults area too small (${end - start} bytes), ${text.length} bytes needed.`,
    );
  }
  if (image.blocks.some((b) => start >= b.address && start < b.address + b.data.length)) {
    throw new BuildToolError("INVALID_ARGS", "Configuration area in firmware not free.");
  }
  const following = image.blocks.findIndex((b) => b.address > start);
  const at = following < 0 ? image.blocks.length : following;
  const nextBlock = image.blocks[at];
  if (nextBlock && start + text.length > nextBlock.address) {
    throw new BuildToolError("INVALID_ARGS", "Aborting data generation, free area too small.");
  }
  const inserted: HexBlock[] = [];
  for (let off = 0; off < text.length; off += INSERT_BLOCK) {
    inserted.push({ address: start + off, data: Uint8Array.from(text.subarray(off, off + INSERT_BLOCK)) });
  }
  image.blocks.splice(at, 0, ...inserted);
  image.bytesTotal += text.length;
  return true;
}

/** Lines the Configurator drops from Betaflight-era (legacy) configs. */
const IGNORE_LEGACY = [
  /^feature [-]?AIRMODE/i, /^feature [-]?ANTI/i, /^feature [-]?DISPLAY/i, /^feature [-]?DYNAMIC/i,
  /^feature [-]?ESC_SENSOR/i, /^feature [-]?GPS/i, /^feature [-]?LED_STRIP/i, /^feature [-]?MOTOR_STOP/i,
  /^feature [-]?OSD/i, /^feature [-]?RSSI/i, /^feature [-]?RX_PARALLEL/i, /^feature [-]?RX_SERIAL/i,
  /^feature [-]?RX_SPI/i, /^feature [-]?SOFTSERIAL/i, /^feature [-]?TELEMETRY/i, /^resource PWM/i,
  /^resource MOTOR [5-8]/i, /^resource OSD/i, /^serial [0-9]/i, /^set serialrx/i, /^set max7456/i,
];

/** Same clean-up the Configurator applies (cleanUnifiedConfigFile). */
export function cleanConfig(input: string): string {
  let out = "";
  let fork = "BF";
  input.split(/[\r\n]+/).forEach((raw, i) => {
    let line = raw;
    if (i === 0 && /^# [A-Za-z]*flight/.test(line)) {
      if (/^# Rotorflight/.test(line)) fork = "RF";
    } else {
      line = line.replace(/#.*$/, "").replace(/[ \t]+$/, "").replace(/[ \t]+/, " ").replace(/^[ ]*$/, "");
      if (!line.length) return;
      if (fork !== "RF" && IGNORE_LEGACY.some((re) => re.test(line))) return;
    }
    out += `${line}\n`;
  });
  return out;
}

/** injectDefaultDesign + injectTargetInfo, as the Configurator does for online board configs. */
export function prepareBoardConfig(
  raw: string,
  meta: { fileName: string; boardKey: string; manufacturer: string; commitHash: string; date: string },
): string {
  let cfg = cleanConfig(raw);
  if (!/board_design [A-Za-z0-9_+-]+\n/m.test(cfg)) {
    const name = cfg.match(/board_name [A-Za-z0-9_+-]+\n/m);
    if (name) cfg = cfg.replace(/board_name [A-Za-z0-9_+-]+\n/gm, `${name[0]}board_design BTFL\n`);
  }
  cfg = cfg.replace(/# config: manufacturer_id: .*\n/gm, "");
  return (
    "## Rotorflight Custom Defaults\n" +
    `# config: ${meta.fileName}\n` +
    `# board: ${meta.boardKey}\n` +
    `# make: ${meta.manufacturer}\n` +
    `# hash: ${meta.commitHash}\n` +
    `# date: ${meta.date}\n` +
    "##\n" +
    cfg
  );
}
