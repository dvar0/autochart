"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { installWindowFit } = require("../electron/windowFit.cjs");
const wait = () => new Promise((resolve) => setTimeout(resolve, 190));

function windowAt(width, height) {
  const win = new EventEmitter();
  win.size = [width, height];
  win.factor = 1;
  win.destroyed = false;
  win.webContents = new EventEmitter();
  win.webContents.isDestroyed = win.isDestroyed = () => win.destroyed;
  win.getContentSize = () => win.size;
  win.webContents.getZoomFactor = () => win.factor;
  win.webContents.setZoomFactor = (factor) => { win.factor = factor; };
  installWindowFit(win);
  win.webContents.emit("did-finish-load");
  return win;
}

(async () => {
  const small = windowAt(1280, 800);
  assert.equal(small.factor, 0.8);
  small.size = [2000, 1200];
  small.emit("resize");
  await wait();
  assert.equal(small.factor, 1);
  small.size = [600, 400];
  small.emit("resize");
  await wait();
  assert.equal(small.factor, 0.6);

  for (const size of [[1920, 1080], [1280, 800]]) {
    const manual = windowAt(...size);
    manual.factor = 0.9; // Simulate View menu zoom without zoom-changed.
    manual.size = [1000, 700];
    manual.emit("resize");
    await wait();
    assert.equal(manual.factor, 0.9, "manual zoom survives resize, including a 100% initial fit");
  }
  const gesture = windowAt(1280, 800);
  gesture.webContents.emit("zoom-changed");
  gesture.size = [1920, 1080];
  gesture.emit("resize");
  await wait();
  assert.equal(gesture.factor, 0.8);
  const closing = windowAt(1280, 800);
  closing.size = [1920, 1080];
  closing.emit("resize");
  closing.destroyed = true;
  closing.emit("closed");
  await wait();
  assert.equal(closing.factor, 0.8);
  console.log("window fit: scaling bounds, resize, manual zoom, and close passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
