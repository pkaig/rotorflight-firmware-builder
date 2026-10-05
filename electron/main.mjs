// Rotorflight Firmware Builder — desktop shell.
//
// Runs the same app server as `npm run app`, in-process, on 127.0.0.1 (a fixed
// port when free), and shows it in a window behind a splash while it starts.
// Builds run natively (on Windows: Git for Windows + GNU make + the Windows ARM
// toolchain; see src/buildenv.ts).
//
// Electron has no built-in device pickers for Web Serial (Detect board) or
// WebUSB (DFU flashing), so this file provides small ones.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// An installed app cannot write next to itself: keep builds where the user can find them.
process.env.RFB_OUTPUT_DIR ??= join(app.getPath("documents"), "Rotorflight Firmware Builder");

const STM32 = 0x0483; // Rotorflight boards: STM32 virtual COM port and ROM DFU bootloader
const hex4 = (n) => (n ?? 0).toString(16).padStart(4, "0");

let server;
let win;
let splash;

// One copy at a time: launching again (easy while a slow start is still
// loading) focuses the running window instead of starting a second app.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = win && !win.isDestroyed() && win.isVisible() ? win : splash;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.focus();
  });
}

/** Shown the moment the app starts; closed once the main window is ready. */
function showSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Rotorflight Firmware Builder",
    backgroundColor: "#121417",
    icon: join(root, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.once("ready-to-show", () => splash?.show());
  splash.loadFile(join(here, "splash.html"));
  splash.on("closed", () => { splash = undefined; });
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.close();
}

/**
 * The page's saved settings (filter, theme, Your setup, toggles) live in
 * browser storage, which belongs to the page's origin, port included. A fixed
 * port keeps the same origin, so they survive a restart; a random port is only
 * the fallback when that one is taken.
 */
const STABLE_PORT = 47821;
async function startOnStablePort(startServer) {
  try {
    return await startServer({ port: STABLE_PORT });
  } catch (err) {
    if (err?.code !== "EADDRINUSE") throw err;
    console.warn(`Port ${STABLE_PORT} is in use; using a random port (saved settings will not carry over this time).`);
    return startServer({ port: 0 });
  }
}

async function createWindow() {
  const { startServer } = await import(pathToFileURL(join(root, "dist", "app", "server.js")).href);
  server ??= await startOnStablePort(startServer);
  // 127.0.0.1, not localhost: the server listens on IPv4 only, and on Windows a
  // refused IPv6 (::1) attempt first can cost seconds.
  const appUrl = `http://127.0.0.1:${server.port}/`;
  console.log(`Rotorflight Firmware Builder: app server at ${appUrl}`);

  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: "Rotorflight Firmware Builder",
    backgroundColor: "#121417", // the Configurator's dark chrome, so there is no white flash on start
    icon: join(root, "build", "icon.png"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(here, "preload.cjs"), // the in-page device chooser bridge
    },
  });
  win.once("ready-to-show", () => {
    win.show();
    closeSplash();
  });

  const origin = new URL(appUrl).origin;
  const ours = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  // Only our own page gets permissions, and only those it uses: serial and USB
  // devices (Detect board, flashing) and writing to the clipboard (Copy names).
  const ses = win.webContents.session;
  const ALLOWED = new Set(["serial", "usb", "clipboard-sanitized-write"]);
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ALLOWED.has(permission) && ours(requestingOrigin));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && ours(details.requestingUrl)));
  ses.setDevicePermissionHandler((details) =>
    (details.deviceType === "serial" || details.deviceType === "usb") && ours(details.origin));

  // Device choosers (Detect board = serial, flashing = USB DFU). Electron has no
  // built-in picker, so the list goes to the page, which shows it in the app's
  // own card (like Chrome's chooser) and answers over IPC. While a chooser is
  // open, devices plugged in or out update the list live.
  const pending = new Map(); // requestId -> { kind, devices, callback }
  let nextId = 1;
  const isRF = (vid) => Number(vid) === STM32;
  const serialEntry = (p) => ({
    id: p.portId,
    name: p.displayName || p.portName || "Serial port",
    detail: [p.portName, p.vendorId ? `${hex4(Number(p.vendorId))}:${hex4(Number(p.productId))}` : ""].filter(Boolean).join(" · "),
    rotorflight: isRF(p.vendorId),
  });
  const usbEntry = (d) => ({
    id: d.deviceId,
    name: d.productName || "USB device",
    detail: [d.manufacturerName, `${hex4(d.vendorId)}:${hex4(d.productId)}`].filter(Boolean).join(" · "),
    rotorflight: isRF(d.vendorId),
  });
  const sortRF = (list) => [...list].sort((a, b) => Number(b.rotorflight) - Number(a.rotorflight));
  const ask = (kind, devices, callback) => {
    const requestId = nextId++;
    pending.set(requestId, { kind, devices: sortRF(devices), callback });
    win.webContents.send("choose-device", { requestId, kind, devices: sortRF(devices) });
  };
  const update = (kind, change) => {
    for (const [requestId, p] of pending) {
      if (p.kind !== kind) continue;
      p.devices = sortRF(change(p.devices));
      win.webContents.send("devices-updated", { requestId, devices: p.devices });
    }
  };
  ipcMain.removeAllListeners("device-chosen");
  ipcMain.on("device-chosen", (e, { requestId, id }) => {
    if (e.sender !== win.webContents) return;
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    const ok = id && p.devices.some((d) => d.id === id);
    if (p.kind === "serial") p.callback(ok ? id : "");
    else p.callback(ok ? id : undefined);
  });

  // navigator.serial.requestPort() — Detect board.
  ses.on("select-serial-port", (event, ports, _wc, callback) => {
    event.preventDefault();
    ask("serial", ports.map(serialEntry), callback);
  });
  ses.on("serial-port-added", (_e, port) => update("serial", (list) => [...list.filter((d) => d.id !== port.portId), serialEntry(port)]));
  ses.on("serial-port-removed", (_e, port) => update("serial", (list) => list.filter((d) => d.id !== port.portId)));

  // navigator.usb.requestDevice() — the DFU bootloader for flashing.
  ses.on("select-usb-device", (event, details, callback) => {
    event.preventDefault();
    ask("usb", details.deviceList.map(usbEntry), callback);
  });
  ses.on("usb-device-added", (_e, device) => update("usb", (list) => [...list.filter((d) => d.id !== device.deviceId), usbEntry(device)]));
  ses.on("usb-device-removed", (_e, device) => update("usb", (list) => list.filter((d) => d.id !== device.deviceId)));

  // Links to other sites open in the system browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!ours(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadURL(appUrl);

  // Smoke test (RFB_SELFTEST=1): check the page and the device-chooser bridge, then quit.
  if (process.env.RFB_SELFTEST) {
    const result = await win.webContents.executeJavaScript(`({
      bridge: typeof window.rfbDesktop?.onChooseDevice === "function",
      chooser: !!document.getElementById("devDialog"),
      title: document.title,
    })`);
    // Seconds since the process started: to the splash, and to the loaded page.
    result.splashAt = splashShownAt;
    result.loadedAt = +process.uptime().toFixed(2);
    console.log("SELFTEST", JSON.stringify(result));
    app.quit();
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open builds folder", click: () => shell.openPath(process.env.RFB_OUTPUT_DIR) },
        {
          // The app's log on disk (it survives restarts): handy when something got stuck.
          label: "Open log file",
          click: async () => {
            const { cacheRoot } = await import(pathToFileURL(join(root, "dist", "config.js")).href);
            shell.openPath(join(cacheRoot(), "app.log"));
          },
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let splashShownAt = null;

app.whenReady().then(async () => {
  if (!primary) return; // a second copy: it only hands focus to the first
  showSplash();
  splash.once("show", () => { splashShownAt = +process.uptime().toFixed(2); });
  buildMenu();
  try {
    await createWindow();
  } catch (err) {
    closeSplash();
    dialog.showErrorBox("Rotorflight Firmware Builder could not start", String(err?.stack ?? err));
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  server?.close();
  app.quit();
});
