"use strict";

// Scale against the design viewport, independent of the current page's content.
function installWindowFit(win) {
  let paused = false;
  let lastFactor = null;
  let timer;
  const apply = () => {
    if (paused || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const current = win.webContents.getZoomFactor();
    // Menu zoom changes do not always emit zoom-changed.
    if (lastFactor !== null && Math.abs(current - lastFactor) > 0.005) {
      paused = true;
      return;
    }
    const [width, height] = win.getContentSize();
    const factor = Math.max(0.6, Math.min(1, width / 1280, height / 1000));
    if (Math.abs(factor - current) > 0.002) win.webContents.setZoomFactor(factor);
    // Track even a no-op fit, so manual zoom from 100% is respected too.
    lastFactor = win.webContents.getZoomFactor();
  };
  win.webContents.once("did-finish-load", apply);
  win.on("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  win.webContents.on("zoom-changed", () => { paused = true; });
  win.once("closed", () => clearTimeout(timer));
}

module.exports = { installWindowFit };
