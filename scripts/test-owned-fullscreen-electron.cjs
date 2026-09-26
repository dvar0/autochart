// Run with: npx electron scripts/test-owned-fullscreen-electron.cjs
// Replays the Windows highway-fullscreen race against the real hook + preload.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-owned-fullscreen-"));
  let win;
  let windowFullscreen = false;
  const setCalls = [];
  let cancelEnter = false;
  let readDelay = 0;
  try {
    await esbuild.build({
      absWorkingDir: ROOT,
      stdin: {
        contents: `
          import React, { useRef } from "react";
          import { createRoot } from "react-dom/client";
          import { useOwnedFullscreen } from "./src/hooks/useOwnedFullscreen.js";
          function Preview() {
            const previewRef = useRef(null);
            const { fullscreen, toggleFullscreen } = useOwnedFullscreen({
              targetRef: previewRef,
              label: "highway",
            });
            return (
              <div>
                <div className={"preview" + (fullscreen ? " is-fullscreen" : "")} ref={previewRef}>highway</div>
                <button type="button" onClick={toggleFullscreen}>
                  {fullscreen ? "Exit" : "Full screen"}
                </button>
              </div>
            );
          }
          const root = createRoot(document.getElementById("root"));
          window.unmountPreview = () => root.unmount();
          root.render(<Preview />);
        `,
        resolveDir: ROOT,
        loader: "jsx",
      },
      bundle: true,
      outfile: path.join(temp, "app.js"),
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "true" },
      logLevel: "silent",
    });
    await fs.writeFile(path.join(temp, "index.html"), '<div id="root"></div><script src="app.js"></script>');

    ipcMain.handle("window:setFullscreen", (event, next) => {
      windowFullscreen = Boolean(next) && !cancelEnter;
      setCalls.push(windowFullscreen);
      if (!event.sender.isDestroyed()) {
        // Windows can emit a leave while entering, then the real enter.
        if (windowFullscreen) event.sender.send("window:fullscreen-changed", false);
        event.sender.send("window:fullscreen-changed", windowFullscreen);
      }
      return windowFullscreen;
    });
    ipcMain.handle("window:isFullscreen", async () => {
      if (readDelay) await new Promise((resolve) => setTimeout(resolve, readDelay));
      return windowFullscreen;
    });

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(ROOT, "electron/preload.cjs"),
        contextIsolation: true,
      },
    });
    await win.loadFile(path.join(temp, "index.html"));
    const evaluate = (code) => win.webContents.executeJavaScript(code, true);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 5000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const overlayOn = () => evaluate(`document.querySelector(".preview").classList.contains("is-fullscreen")`);
    const buttonLabel = () => evaluate(`document.querySelector("button").textContent.trim()`);

    await waitFor(() => evaluate(`Boolean(document.querySelector("button"))`), "fullscreen button");
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(overlayOn, "highway overlay after first click");
    await evaluate(`document.dispatchEvent(new Event("fullscreenchange"))`);
    assert.equal(await overlayOn(), true, "DOM fullscreenchange must not clear the Electron overlay");
    win.webContents.send("window:fullscreen-changed", false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await overlayOn(), true, "spurious leave-full-screen must not clear the overlay");
    assert.equal(await buttonLabel(), "Exit");
    assert.equal(windowFullscreen, true, "window fullscreen must stay on after the enter race");

    await evaluate(`document.querySelector("button").click()`);
    await waitFor(async () => !(await overlayOn()), "overlay off after Exit");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(windowFullscreen, false, "Exit must leave Electron fullscreen");
    assert.deepEqual(setCalls, [true, false], "owned surface must set then unset window fullscreen");

    setCalls.length = 0;
    windowFullscreen = true;
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(overlayOn, "overlay on when window is already fullscreen");
    assert.deepEqual(setCalls, [], "already-fullscreen window must not be toggled on enter");
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(async () => !(await overlayOn()), "overlay off after Exit over F11");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(windowFullscreen, true, "F11 fullscreen must not be stolen on Exit");
    assert.deepEqual(setCalls, [], "already-fullscreen window must not be toggled on exit");

    // A genuine native exit must dismiss the overlay, unlike a stale leave event.
    windowFullscreen = false;
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(() => windowFullscreen, "native enter");
    windowFullscreen = false;
    win.webContents.send("window:fullscreen-changed", false);
    await waitFor(async () => !(await overlayOn()), "real native leave");

    cancelEnter = true;
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(overlayOn, "pending enter overlay");
    await waitFor(async () => !(await overlayOn()), "cancelled native enter clears overlay");
    cancelEnter = false;

    // Cancelling before the initial state query resolves must not enter later.
    setCalls.length = 0;
    readDelay = 100;
    await evaluate(`document.querySelector("button").click()`);
    await waitFor(overlayOn, "pending state query");
    await evaluate(`document.querySelector("button").click()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(await overlayOn(), false);
    assert.deepEqual(setCalls, [], "cancelled query must not toggle the window");

    await evaluate(`document.querySelector("button").click()`);
    await waitFor(overlayOn, "overlay before navigation");
    await evaluate(`window.unmountPreview()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(setCalls, [], "navigation during state query must not enter fullscreen");

    console.log("owned fullscreen: enter races, native leave, cancellation, navigation, and F11 ownership passed");
  } finally {
    win?.destroy();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

app.on("window-all-closed", () => {});
app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  console.error(error.stack || error.message || error);
  app.exit(1);
});
