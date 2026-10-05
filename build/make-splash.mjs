// Renders electron/splash.html to build/portable-splash.bmp: the picture the
// portable .exe shows while it unpacks itself (before the app can run any code).
// The installed app shows the live splash window instead.
//
//   npx electron build/make-splash.mjs

import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const W = 420;
const H = 240;

/** 24-bit bottom-up BMP from Electron's BGRA bitmap (what NSIS expects). */
function toBmp(bgra, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const b = Buffer.alloc(size);
  b.write("BM", 0);
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(rowSize * height, 34);
  for (let y = 0; y < height; y++) {
    const out = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      b[out + x * 3] = bgra[i];
      b[out + x * 3 + 1] = bgra[i + 1];
      b[out + x * 3 + 2] = bgra[i + 2];
    }
  }
  return b;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, useContentSize: true });
  await win.loadFile(join(here, "..", "electron", "splash.html"));
  // A still picture: no spinner, and say what is actually happening.
  await win.webContents.executeJavaScript(`
    document.querySelector(".spinner").remove();
    document.querySelector(".status").textContent = "Unpacking… the portable app takes a moment to start";
  `);
  await new Promise((r) => setTimeout(r, 300));
  const img = (await win.webContents.capturePage()).resize({ width: W, height: H });
  const out = join(here, "portable-splash.bmp");
  writeFileSync(out, toBmp(img.toBitmap(), W, H));
  console.log(`Wrote ${out}`);
  app.quit();
});
