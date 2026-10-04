// Rotorflight Firmware Builder — desktop shell.
//
// Runs the same app server as `npm run app`, in-process, on a free localhost
// port, and shows it in a window. Builds run natively (on Windows: Git for
// Windows + GNU make + the Windows ARM toolchain; see src/buildenv.ts).
//
// Electron has no built-in device pickers for Web Serial (Detect board) or
// WebUSB (DFU flashing), so this file provides small ones.

import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
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

async function createWindow() {
  const { startServer } = await import(pathToFileURL(join(root, "dist", "app", "server.js")).href);
  server ??= await startServer({ port: 0 });
  console.log(`Rotorflight Firmware Builder: app server at ${server.url}`);

  win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    title: "Rotorflight Firmware Builder",
    backgroundColor: "#121417", // the Configurator's dark chrome, so there is no white flash on start
    icon: join(root, "build", "icon.png"),
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());

  const origin = new URL(server.url).origin;
  const ours = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  // Only our own page may use serial and USB devices.
  const ses = win.webContents.session;
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ["serial", "usb"].includes(permission) ? ours(requestingOrigin) : true);
  ses.setDevicePermissionHandler((details) =>
    (details.deviceType === "serial" || details.deviceType === "usb") && ours(details.origin));

  // navigator.serial.requestPort() — Detect board.
  ses.on("select-serial-port", async (event, ports, _wc, callback) => {
    event.preventDefault();
    if (!ports.length) {
      await dialog.showMessageBox(win, { type: "info", message: "No serial ports found.", detail: "Plug the flight controller in (without holding BOOT) and try again." });
      return callback("");
    }
    const sorted = [...ports].sort((a, b) => Number(b.vendorId === `${STM32}` || Number(b.vendorId) === STM32) - Number(a.vendorId === `${STM32}` || Number(a.vendorId) === STM32));
    const labels = sorted.map((p) => `${p.portName}${p.displayName ? ` — ${p.displayName}` : ""}${p.vendorId ? ` (${hex4(Number(p.vendorId))}:${hex4(Number(p.productId))})` : ""}`);
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Select serial port",
      message: "Which serial port is the flight controller?",
      detail: "Rotorflight boards usually show as an STM32 Virtual COM Port (0483:5740).",
      buttons: [...labels, "Cancel"],
      cancelId: labels.length,
      defaultId: 0,
      noLink: true,
    });
    callback(response < sorted.length ? sorted[response].portId : "");
  });

  // navigator.usb.requestDevice() — the DFU bootloader for flashing.
  ses.on("select-usb-device", async (event, details, callback) => {
    event.preventDefault();
    const devices = details.deviceList;
    if (!devices.length) {
      await dialog.showMessageBox(win, {
        type: "info",
        message: "No DFU device found.",
        detail: "Put the board in DFU mode (hold BOOT while plugging in). On Windows the STM32 BOOTLOADER device needs the WinUSB driver.",
      });
      return callback();
    }
    const labels = devices.map((d) => `${d.productName || "USB device"} (${hex4(d.vendorId)}:${hex4(d.productId)})`);
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Select DFU device",
      message: "Which device is the board in DFU mode?",
      buttons: [...labels, "Cancel"],
      cancelId: labels.length,
      defaultId: 0,
      noLink: true,
    });
    callback(response < devices.length ? devices[response].deviceId : undefined);
  });

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

  await win.loadURL(server.url);
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open builds folder", click: () => shell.openPath(process.env.RFB_OUTPUT_DIR) },
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

app.whenReady().then(async () => {
  buildMenu();
  try {
    await createWindow();
  } catch (err) {
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
