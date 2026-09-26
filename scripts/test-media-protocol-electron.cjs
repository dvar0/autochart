"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, protocol } = require("electron");

const libraryStore = require("../electron/libraryStore.cjs");
const {
  MEDIA_SCHEME,
  createMediaProtocolHandler,
  mediaAssetUrl,
} = require("../electron/mediaProtocol.cjs");

protocol.registerSchemesAsPrivileged([{
  scheme: MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-media-protocol-"));
  try {
    const context = {
      userDataPath: path.join(root, "user-data"),
      projectsFolder: path.join(root, "projects"),
    };
    const content = "0123456789abcdefghijklmnopqrstuvwxyz";
    const saved = await libraryStore.saveSong(context, {
      record: {
        id: "protocol-project",
        meta: { title: "Protocol" },
        chart: { text: "[Song]\n{\n  Name = Protocol\n}\n" },
        assets: {},
      },
      assets: {
        audio: {
          name: "protocol.ogg",
          mime: "audio/ogg",
          data: Buffer.from(content),
        },
      },
    });
    protocol.handle(
      MEDIA_SCHEME,
      createMediaProtocolHandler({
        getSource: (songId, fileName) =>
          libraryStore.getMediaAssetSource(context, songId, fileName),
      })
    );

    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    const url = mediaAssetUrl(saved.id, saved.assets.audio, "test");
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const response = await fetch(${JSON.stringify(url)}, {
          headers: { Range: "bytes=5-10" },
        });
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          contentType: response.headers.get("content-type"),
          body: await response.text(),
        };
      })()
    `);
    assert.equal(result.status, 206);
    assert.equal(result.contentRange, `bytes 5-10/${content.length}`);
    assert.equal(result.contentType, "audio/ogg");
    assert.equal(result.body, content.slice(5, 11));
    win.destroy();
    console.log("media protocol electron: renderer CSP/CORS and byte-range streaming passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
