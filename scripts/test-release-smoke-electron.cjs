"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");

const {
  RELEASE_SMOKE_CHANNEL,
  createReleaseSmokePingHandler,
  waitForReleaseSmokeRenderer,
} = require("../electron/releaseSmoke.cjs");

async function main() {
  const authorizedSenderIds = new Set();
  ipcMain.handle(
    RELEASE_SMOKE_CHANNEL,
    createReleaseSmokePingHandler({ enabled: true }, authorizedSenderIds)
  );

  const windowOptions = {
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  const authorized = new BrowserWindow(windowOptions);
  try {
    authorizedSenderIds.add(authorized.webContents.id);
    await authorized.loadURL("data:text/html,<main id='root'><div>Autochart</div></main>");

    await waitForReleaseSmokeRenderer(authorized, {
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    console.log("release smoke electron: packaged-style preload and sender-bound IPC passed");
  } finally {
    authorized.destroy();
    ipcMain.removeHandler(RELEASE_SMOKE_CHANNEL);
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
