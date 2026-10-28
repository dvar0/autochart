#!/usr/bin/env node
"use strict";

// Writes the signed update.json for a staged release (see docs/github-release.md).
// Usage: AUTOCHART_UPDATE_SIGNING_KEY=/path/to/key.pem \
//   node scripts/make-update-feed.cjs /staged/release notes.json
// notes.json (everything but features is optional):
//   { "headline": "Fretformer 3 is here", "sub": "One line under it.",
//     "features": [{ "icon": "music", "title": "Drum charts", "text": "One line." }],
//     "fixes": ["Smaller change or fix.", ...],
//     "image": "update-hero.webp", "notesUrl": "https://…", "important": false }
// The image is a file in the staged release (at most 2 MB, png/jpg/webp) and
// is uploaded with it. notesUrl defaults to the GitHub release page.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { verifyFeed } = require("../electron/appUpdates.cjs");

const REPO = "https://github.com/dvar0/autochart";
// The staged download each target updates from.
const TARGET_FILES = {
  "linux-x64": "-linux-x86_64.AppImage",
  "win32-x64": "-win-x64.exe",
  "darwin-arm64": "-arm64.dmg",
};

function checksums(text) {
  const entries = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function makeUpdateFeed({ dir, notes = {}, privateKeyPem, version, repo = REPO }) {
  const { headline = "", sub = "", features = [], fixes = [], image = "", notesUrl = "", important = false } = notes;
  const sums = checksums(await fs.readFile(path.join(dir, "SHA256SUMS.txt"), "utf8"));
  const files = {};
  for (const [target, suffix] of Object.entries(TARGET_FILES)) {
    const name = `Autochart-${version}${suffix}`;
    if (!sums.has(name)) throw new Error(`Missing staged download: ${name}`);
    const stat = await fs.stat(path.join(dir, name));
    files[target] = {
      name,
      url: `${repo}/releases/download/v${version}/${name}`,
      size: stat.size,
      sha256: sums.get(name),
    };
  }
  let imageEntry;
  if (image) {
    const bytes = await fs.readFile(path.join(dir, image));
    imageEntry = {
      name: image,
      url: `${repo}/releases/download/v${version}/${image}`,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }
  const payload = JSON.stringify({
    schemaVersion: 1,
    product: "Autochart",
    version,
    important: important === true,
    ...(headline ? { headline } : {}),
    ...(sub ? { sub } : {}),
    ...(imageEntry ? { image: imageEntry } : {}),
    features,
    fixes,
    page: `${repo}/releases/tag/v${version}`,
    notesUrl: notesUrl || `${repo}/releases/tag/v${version}`,
    files,
  }, null, 2);
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
  const text = `${JSON.stringify({ payload, signature }, null, 2)}\n`;
  return { text, publicKey: crypto.createPublicKey(key).export({ type: "spki", format: "pem" }) };
}

async function main() {
  const [dir, notesPath] = process.argv.slice(2);
  const keyPath = process.env.AUTOCHART_UPDATE_SIGNING_KEY;
  if (!dir || !notesPath || !keyPath) {
    throw new Error("Usage: AUTOCHART_UPDATE_SIGNING_KEY=key.pem node scripts/make-update-feed.cjs <staged-release> <notes.json>");
  }
  const { text } = await makeUpdateFeed({
    dir,
    notes: JSON.parse(await fs.readFile(notesPath, "utf8")),
    privateKeyPem: await fs.readFile(keyPath, "utf8"),
    version: require("../package.json").version,
  });
  // Checked against the key the app ships with, so a wrong key fails here
  // instead of in every installed copy.
  verifyFeed(text);
  const output = path.join(dir, "update.json");
  await fs.writeFile(output, text, { flag: "wx" });
  console.log(`Wrote ${output}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { makeUpdateFeed, TARGET_FILES };
