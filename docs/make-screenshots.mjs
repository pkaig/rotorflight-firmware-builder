// Captures the screenshots in docs/images/ for docs/Rotorflight-firmware-build-manual.md
// by driving the real app in a hidden (headless) Electron window.
//
//   npm run build && npx electron docs/make-screenshots.mjs [path-to-a-firmware-clone]
//
// It runs with a scratch cache, profile and output folder, so the pictures show a
// fresh app: none of your own builds, names or saved settings. The scratch cache
// links to your existing release checkouts (sources/), so nothing is downloaded
// again, but two builds of release/4.6.0 do run (about two minutes each).
// The optional clone is only loaded and previewed (never built), for the
// "firmware guards" pictures.

import { app, BrowserWindow } from "electron";
import { mkdirSync, mkdtempSync, rmdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, "images");
const RELEASE = "release/4.6.0";
const BOARD = "FRSK-VANTAC_RF007"; // an STM32F7X2 board
const TARGET = "STM32F7X2";
const clone = process.argv.slice(2).find((a) => !a.startsWith("-") && existsSync(join(a, "Makefile")));

// Scratch everything (must happen before the app is ready / the server loads).
const scratch = mkdtempSync(join(tmpdir(), "rfb-shots-"));
const cache = join(scratch, "cache");
mkdirSync(cache, { recursive: true });
const realSources = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "rotorflight-firmware-builder", "sources");
const sourcesLink = join(cache, "sources");
if (existsSync(realSources)) symlinkSync(realSources, sourcesLink, "junction");
process.env.RFB_CACHE_DIR = cache;
process.env.RFB_OUTPUT_DIR = join(scratch, "output");
app.setPath("userData", join(scratch, "profile"));

// Windows come and go during the run: only quit when the run says so.
app.on("window-all-closed", () => {});

const W = 1500;
const H = 960;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  let win;
  try {
    // --- splash -----------------------------------------------------------------------
    const splash = new BrowserWindow({ width: 420, height: 240, frame: false, show: false, useContentSize: true, webPreferences: { offscreen: true } });
    await splash.loadFile(join(root, "electron", "splash.html"));
    await sleep(400);
    save("splash", await splash.webContents.capturePage());
    splash.destroy();

    // --- the app ----------------------------------------------------------------------
    const { startServer } = await import(pathToFileURL(join(root, "dist", "app", "server.js")).href);
    const server = await startServer({ port: 0 });
    win = new BrowserWindow({
      width: W, height: H, show: false, useContentSize: true, backgroundColor: "#121417",
      // Offscreen rendering: Electron's headless mode. Every frame is rendered in
      // memory, so captures are current (a plain hidden window can return stale
      // frames) and come out at 1:1 scale whatever the display scaling.
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: join(root, "electron", "preload.cjs") },
    });
    win.webContents.setFrameRate(30);
    await win.loadURL(`http://127.0.0.1:${server.port}/`);
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (expr, ms = 60000, what = expr) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(`!!(${expr})`)) return;
        await sleep(250);
      }
      throw new Error(`Timed out waiting for: ${what}`);
    };
    /** Crop to the union of these elements (scrolled into view), plus padding. */
    const shot = async (name, selectors, { pad = 10, maxHeight = H } = {}) => {
      const rect = await js(`(() => {
        const els = ${JSON.stringify([].concat(selectors))}.map((s) => document.querySelector(s)).filter(Boolean);
        if (!els.length) return null;
        els[0].scrollIntoView({ block: "start" });
        const rs = els.map((e) => e.getBoundingClientRect());
        const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - ${pad});
        const y = Math.max(0, Math.min(...rs.map((r) => r.top)) - ${pad});
        const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + ${pad});
        const bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + ${pad}, y + ${maxHeight});
        return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
      })()`);
      if (!rect) throw new Error(`Nothing to capture for ${name}`);
      await fresh();
      save(name, await win.webContents.capturePage(rect));
    };
    const fresh = async () => {
      await sleep(400);
      win.webContents.invalidate();
      await sleep(200);
    };
    const full = async (name) => {
      await js("scrollTo(0, 0)");
      await fresh();
      save(name, await win.webContents.capturePage());
    };

    // First start: nothing loaded yet.
    await until(`boards.length && $("release").options.length > 1`, 60000, "board and release lists");
    await full("first-start");

    // The build-environment prompt, as a PC without GNU make sees it.
    await js(`showEnv({ ok: false, platform: "win32", problems: ["GNU make was not found. Install it with: winget install ezwinports.make"],
      installable: [{ id: "ezwinports.make", name: "GNU make" }], canInstall: true }); promptEnv();`);
    await sleep(300);
    await shot("build-environment", "#envDialog");
    await js(`$("envDialog").close(); api("/api/env").then(showEnv);`);
    await sleep(300);

    // The in-app manual (the Manual button in the title bar).
    await js(`$("manualBtn").click()`);
    await until(`$("manualDialog").open && $("manualBody").querySelector("h1")`, 30000, "manual");
    await shot("manual", "#manualDialog", { pad: 0 });
    await js(`$("manualDialog").close()`);

    // Pick the board (as Detect would), then the release.
    await js(`(async () => {
      const b = boards.find((x) => x.key === ${JSON.stringify(BOARD)});
      if (b && !b.supported) $("legacy").checked = true;
      renderBoards(${JSON.stringify(BOARD)});
      await pickBoard(${JSON.stringify(BOARD)});
      $("release").value = ${JSON.stringify(RELEASE)};
      $("release").dispatchEvent(new Event("change"));
    })()`);
    await until(`$("target").value === ${JSON.stringify(TARGET)} && /official/.test($("releaseSize").textContent)`, 60000, "board target and release size");
    await shot("header", "header");

    // Load: catch the progress banner while the probe runs.
    await js(`$("load").click()`);
    await until(`!$("jobBanner").hidden && /Probing/.test($("jobStep").textContent)`, 300000, "probe progress");
    await sleep(1500);
    await shot("loading", ["header", "#jobBanner"], { pad: 0 });
    await until(`session && session.target === ${JSON.stringify(TARGET)} && !busy`, 600000, "load to finish");
    await sleep(1500);
    await full("loaded");
    await shot("your-setup", "#setup");

    // Options: All, then the details card.
    await js(`$("chips").querySelector('[data-f="all"]').click()`);
    await sleep(400);
    await shot("options-all", ["#tools", "#list"], { maxHeight: 620 });
    await js(`(() => { const r = document.querySelector('[data-row="USE_GPS"]') ?? document.querySelector("[data-row]");
      r.scrollIntoView({ block: "center" }); r.querySelector("[data-info]").click(); })()`);
    await fresh();
    save("details-card", await win.webContents.capturePage());
    await js(`closeCard()`);

    // Switch an addable option on, to show a selection and its preview.
    const added = await js(`(() => {
      const o = session.probe.options.find((x) => x.name === "USE_RANGEFINDER_HCSR04" && x.state === "off-addable")
        ?? session.probe.options.find((x) => x.state === "off-addable" && x.scope === "generic");
      const box = document.querySelector('[data-n="' + o.name + '"]');
      box.click();
      return o.name;
    })()`);
    await until(`/Effective change/.test($("preview").textContent)`, 60000, "selection preview");
    await js(`$("chips").querySelector('[data-f="changes"]').click()`);
    await sleep(500);
    await shot("options-changes", ["#tools", "#list"], { maxHeight: 400 });
    await js(`$("buildName").value = "Rangefinder test"`);
    await shot("selection", ".stack");
    await shot("flash-budget", "#budget");

    // Build the baseline, then the selection.
    await js(`$("log").replaceChildren()`);
    await js(`api("/api/build", { add: [], remove: [] })`);
    await until(`builds.some((h) => !h.options.length && h.ok) && !busy`, 900000, "baseline build");
    await js(`$("buildName").value = "Rangefinder test"; $("build").click()`);
    await until(`!busy && builds.some((h) => h.name === "Rangefinder test")`, 900000, "named build");
    await sleep(1000);
    await shot("flash-budget-built", "#budget");
    await shot("log", "#log", { pad: 14 });
    await js(`$("log").classList.add("expanded")`);
    await sleep(400);
    await shot("log-expanded", "#log", { pad: 14 });
    await js(`$("log").classList.remove("expanded"); $("buildsPanel").open = true;`);
    await sleep(300);
    await shot("builds", "#buildsPanel");

    // Flash dialog (as with a board in DFU mode, so the controls are enabled).
    await js(`dfuPresent = true; updateButtons(); renderHistory(); openFlash(builds.findIndex((h) => h.name === "Rangefinder test"));`);
    await until(`/Board config/.test($("flashInfo").textContent)`, 60000, "flash dialog");
    await sleep(300);
    await shot("flash-dialog", "#flashDialog");
    await js(`$("flashDialog").close(); dfuPresent = false; updateButtons(); renderHistory();`);

    // The device chooser (as the desktop app shows it for Detect board).
    await js(`devReq = { requestId: -1, kind: "serial", devices: [
        { id: "a", name: "STM32 Virtual ComPort", detail: "COM5 · 0483:5740", rotorflight: true },
        { id: "b", name: "USB Serial Device", detail: "COM3 · 10c4:ea60", rotorflight: false } ] };
      devPick = null; devAnswered = true;
      $("devTitle").textContent = "Select the flight controller's serial port";
      $("devHint").textContent = "Rotorflight boards show as an STM32 virtual COM port (0483:5740).";
      renderDevices(); $("devDialog").showModal();`);
    await sleep(300);
    await shot("device-chooser", "#devDialog");
    await js(`$("devDialog").close()`);

    // Open directory.
    if (clone) {
      await js(`$("dirDialog").showModal(); showDir(${JSON.stringify(dirname(clone))});`);
      await until(`/firmware/.test($("dirStatus").textContent) || $("dirList").children.length > 1`, 30000, "folder listing");
      await sleep(300);
      await shot("open-directory", "#dirDialog");
      await js(`$("dirDialog").close()`);

      // A local clone with firmware guards: load it and untick some features.
      await js(`store("rfb.srcdir", ${JSON.stringify(clone)});
        document.querySelector('input[name="srcmode"][value="local"]').checked = true; applySourceMode();`);
      await sleep(800);
      await js(`selectTarget(${JSON.stringify(TARGET)}); $("load").click()`);
      await until(`session && session.local && !busy`, 600000, "local tree load");
      await sleep(1500);
      await js(`(() => {
        for (const id of ["gps", "ibus", "spektrum", "hott", "jeti", "xbus"]) {
          const box = document.querySelector('[data-feature="' + id + '"]');
          if (box && box.checked) { box.checked = false; box.dispatchEvent(new Event("change", { bubbles: true })); }
        }
      })()`);
      await until(`/Effective change/.test($("preview").textContent)`, 60000, "guard preview");
      await js(`$("chips").querySelector('[data-f="changes"]').click()`);
      await sleep(600);
      await shot("guards-setup", "#setup");
      await shot("guards-changes", ["#tools", "#list"], { maxHeight: 620 });
      await shot("guards-selection", ".stack");
      await shot("guards-budget", "#budget");
    }
    console.log(`Screenshots written to ${out}${clone ? "" : " (no firmware clone given: guard pictures skipped)"}`);
    console.log(`Added option for the selection pictures: ${added}`);
  } catch (err) {
    console.error(err);
    if (win) save("error-state", await win.webContents.capturePage());
    process.exitCode = 1;
  } finally {
    // Remove only the link to the real sources, never what it points at.
    try { if (existsSync(sourcesLink)) rmdirSync(sourcesLink); } catch {}
    console.log(`Scratch folder (safe to delete): ${scratch}`);
    app.quit();
  }
});

function save(name, image) {
  writeFileSync(join(out, `${name}.png`), image.toPNG());
  console.log(`  ${name}.png ${image.getSize().width}x${image.getSize().height}`);
}
