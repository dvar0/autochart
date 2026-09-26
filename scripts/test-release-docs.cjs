#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readme = read("README.md");
const agents = read("AGENTS.md");
const notices = read("docs/third-party-notices.md");
const checklist = read("docs/release-checklist.md");
const releaseNotes = read("docs/release-notes.md");

assert(checklist.includes("npm run release:stage"), "Release checklist must document public staging");
assert(checklist.indexOf("npm run release:verify") < checklist.indexOf("npm run release:stage"), "Release verification must precede public staging");
assert.match(notices, /FFmpeg 9\.0\.1/);
assert.match(notices, /LGPL-2\.1-or-later/);
assert.doesNotMatch(agents, /IndexedDB\/localStorage mock data/);
assert.match(agents, /test:release-smoke.*sender-bound Electron preload\/release-smoke probe/);
for (const document of [readme, checklist, releaseNotes]) {
  assert.match(document, /WebGPU/);
  assert.match(document, /CPU/);
  assert.match(document, /falls? ?back/i);
}
assert.match(checklist, /Supported target and fallback matrix/);
assert.match(releaseNotes, /macOS Apple Silicon \| DMG/);
console.log("release documentation alignment checks passed");
