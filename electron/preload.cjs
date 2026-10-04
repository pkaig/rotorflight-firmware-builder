// Bridge for the in-page device chooser. Electron has no built-in picker for
// Web Serial / WebUSB, so the main process hands the device list to the page,
// which shows it in the app's own card (matching Chrome's chooser) and replies.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rfbDesktop", {
  /** cb({ requestId, kind: "serial" | "usb", devices: [{ id, name, detail, rotorflight }] }) */
  onChooseDevice: (cb) => ipcRenderer.on("choose-device", (_e, req) => cb(req)),
  /** cb({ requestId, devices }) — the list changed while the chooser is open. */
  onDevicesUpdated: (cb) => ipcRenderer.on("devices-updated", (_e, req) => cb(req)),
  /** Answer a request: a device id, or "" / null to cancel. */
  deviceChosen: (requestId, id) => ipcRenderer.send("device-chosen", { requestId, id }),
});
