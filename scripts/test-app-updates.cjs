#!/usr/bin/env node
"use strict";

// Update feed signing, offer/announce/what's-new state, download checks, and
// the AppImage swap. No network: the feed and downloads are faked.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  compareVersions, createAppUpdates, detectInstallMode, replaceAppImage, verifyFeed,
} = require("../electron/appUpdates.cjs");
const { makeUpdateFeed } = require("./make-update-feed.cjs");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" });
const PRIVATE = privateKey.export({ type: "pkcs8", format: "pem" });
const BYTES = Buffer.from("new autochart build");
const SHA = crypto.createHash("sha256").update(BYTES).digest("hex");

function signed(feed, key = privateKey) {
  const payload = JSON.stringify(feed);
  return JSON.stringify({ payload, signature: crypto.sign(null, Buffer.from(payload), key).toString("base64") });
}

function feed(overrides = {}) {
  return {
    schemaVersion: 1,
    product: "Autochart",
    version: "0.3.0",
    important: false,
    features: [{ icon: "spark", title: "Faster", text: "Everything is." }],
    fixes: ["One fix"],
    page: "https://example.com/releases/tag/v0.3.0",
    files: {
      "linux-x64": { name: "Autochart-0.3.0-linux-x86_64.AppImage", url: "https://example.com/a.AppImage", size: BYTES.length, sha256: SHA },
    },
    ...overrides,
  };
}

let root = "";
async function tempDir() {
  return fs.mkdtemp(path.join(root, "case-"));
}

function updater(userDataPath, options = {}) {
  let clock = options.clock ?? 1_000_000_000_000;
  const states = [];
  const instance = createAppUpdates({
    userDataPath,
    currentVersion: "0.2.0",
    target: "linux-x64",
    installMode: "replace",
    publicKey: PUBLIC,
    fetchText: async () => options.feedText ?? signed(feed()),
    downloadFile: async ({ targetPath, expectedSha256, expectedSize, onProgress }) => {
      assert.equal(expectedSha256, SHA);
      assert.equal(expectedSize, BYTES.length);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, BYTES);
      onProgress?.({ percent: 100 });
      return { path: targetPath };
    },
    readSettings: async () => options.settings ?? { setupComplete: true, checkForUpdates: true },
    now: () => clock,
    onChange: (state) => states.push(state),
  });
  return { instance, states, advance: (ms) => { clock += ms; } };
}

async function main() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-updates-"));
  // Versions
  assert.equal(compareVersions("0.2.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1);

  // Signatures and feed shape
  assert.equal(verifyFeed(signed(feed()), PUBLIC).feed.version, "0.3.0");
  const tampered = JSON.parse(signed(feed()));
  tampered.payload = tampered.payload.replace("0.3.0", "9.9.9");
  assert.throws(() => verifyFeed(JSON.stringify(tampered), PUBLIC), /signature/);
  const other = crypto.generateKeyPairSync("ed25519").privateKey;
  assert.throws(() => verifyFeed(signed(feed(), other), PUBLIC), /signature/);
  assert.throws(() => verifyFeed(JSON.stringify(feed()), PUBLIC), /not signed/);
  assert.throws(() => verifyFeed(signed(feed({ page: "http://example.com" })), PUBLIC), /https/);
  assert.throws(() => verifyFeed(signed(feed({ files: { "linux-x64": { ...feed().files["linux-x64"], name: "../x" } } })), PUBLIC), /name/);
  assert.throws(() => verifyFeed(signed(feed({ features: Array(9).fill({ title: "x" }) })), PUBLIC), /features/);
  assert.throws(() => verifyFeed(signed(feed({ features: [{ text: "no title" }] })), PUBLIC), /features/);
  assert.throws(() => verifyFeed(signed(feed({ features: [{ icon: "<svg>", title: "x" }] })), PUBLIC), /features/);
  assert.throws(() => verifyFeed(signed(feed({ fixes: ["x".repeat(161)] })), PUBLIC), /fixes/);
  assert.throws(() => verifyFeed(signed(feed({ notesUrl: "http://example.com" })), PUBLIC), /https/);
  assert.equal(verifyFeed(signed(feed({ notesUrl: "https://hub.example/releases/0.3.0" })), PUBLIC).feed.notesUrl, "https://hub.example/releases/0.3.0");
  const picture = { name: "hero.webp", url: "https://example.com/hero.webp", size: BYTES.length, sha256: SHA };
  assert.equal(verifyFeed(signed(feed({ headline: "Big one", image: picture })), PUBLIC).feed.image.name, "hero.webp");
  assert.throws(() => verifyFeed(signed(feed({ image: { ...picture, name: "hero.svg" } })), PUBLIC), /image/);
  assert.throws(() => verifyFeed(signed(feed({ image: { ...picture, size: 3 * 1024 * 1024 } })), PUBLIC), /image/);
  assert.throws(() => verifyFeed(signed(feed({ headline: "x".repeat(81) })), PUBLIC), /headline/);
  // The shipped key is a real Ed25519 key, and a test-signed feed doesn't pass it.
  assert.throws(() => verifyFeed(signed(feed())), /signature/);

  // Install modes
  assert.equal(detectInstallMode({ packaged: false, platform: "linux", env: { APPIMAGE: "/x" } }), "page");
  assert.equal(detectInstallMode({ packaged: true, platform: "linux", env: { APPIMAGE: "/x" } }), "replace");
  assert.equal(detectInstallMode({ packaged: true, platform: "linux", env: {} }), "page");
  assert.equal(detectInstallMode({ packaged: true, platform: "darwin", execPath: "/Applications/Autochart.app/Contents/MacOS/Autochart" }), "dmg");
  const winDir = await tempDir();
  assert.equal(detectInstallMode({ packaged: true, platform: "win32", execPath: path.join(winDir, "Autochart.exe") }), "page");
  await fs.writeFile(path.join(winDir, "Uninstall Autochart.exe"), "");
  assert.equal(detectInstallMode({ packaged: true, platform: "win32", execPath: path.join(winDir, "Autochart.exe") }), "installer");

  // Fresh install: nothing to show, version remembered.
  {
    const dir = await tempDir();
    const { instance } = updater(dir, { settings: { setupComplete: false } });
    assert.equal((await instance.init()).whatsNewSince, "");
    const again = updater(dir, { settings: { setupComplete: true } }).instance;
    assert.equal((await again.init()).whatsNewSince, "");
  }

  // Coming from a release without update tracking.
  {
    const dir = await tempDir();
    const { instance } = updater(dir);
    assert.equal((await instance.init()).whatsNewSince, "0.0.0");
    assert.equal((await instance.markWhatsNewSeen()).whatsNewSince, "");
    assert.equal((await updater(dir).instance.init()).whatsNewSince, "");
  }

  // Upgrade from a tracked version.
  {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "updates.json"), JSON.stringify({ lastSeenVersion: "0.1.5" }));
    assert.equal((await updater(dir).instance.init()).whatsNewSince, "0.1.5");
  }

  // Checking, offering, dismissing, announcing.
  {
    const dir = await tempDir();
    const { instance, advance } = updater(dir, { feedText: signed(feed({ important: true })) });
    await instance.init();
    let state = await instance.check();
    assert.equal(state.update.version, "0.3.0");
    assert.equal(state.update.installMode, "replace");
    assert.equal(state.update.size, BYTES.length);
    assert.deepEqual(state.update.features, [{ icon: "spark", title: "Faster", text: "Everything is." }]);
    assert.deepEqual(state.update.fixes, ["One fix"]);
    assert.equal(state.update.notesUrl, "https://example.com/releases/tag/v0.3.0");
    assert.equal(state.announce, true);
    assert.equal(state.dismissed, false);
    assert.equal((await instance.markAnnounced()).announce, false);
    assert.equal((await instance.dismiss()).dismissed, true);
    // The offer survives a restart, still verified and still dismissed.
    state = await updater(dir).instance.init();
    assert.equal(state.update.version, "0.3.0");
    assert.equal(state.dismissed, true);
    assert.equal(state.announce, false);
    // Automatic checks wait a day; manual ones don't.
    const lastCheckedAt = state.lastCheckedAt;
    advance(60_000);
    assert.equal((await instance.check()).lastCheckedAt, lastCheckedAt);
    assert.notEqual((await instance.check({ manual: true })).lastCheckedAt, lastCheckedAt);
  }

  // Automatic checks are off with the setting; a bad feed changes nothing.
  {
    const dir = await tempDir();
    const off = updater(dir, { settings: { setupComplete: true, checkForUpdates: false } }).instance;
    await off.init();
    assert.equal((await off.check()).lastCheckedAt, 0);
    const bad = updater(dir, { feedText: "{}" }).instance;
    await bad.init();
    const state = await bad.check({ manual: true });
    assert.equal(state.update, null);
    assert.match(state.error, /Couldn't check/);
  }

  // Older or equal versions aren't offered; a target without its file, or a
  // file that doesn't fit the install mode, falls back to the page.
  {
    const dir = await tempDir();
    assert.equal(await (async () => {
      const { instance } = updater(dir, { feedText: signed(feed({ version: "0.2.0" })) });
      await instance.init();
      return (await instance.check({ manual: true })).update;
    })(), null);
    const missing = updater(await tempDir(), { feedText: signed(feed({ files: {} })) }).instance;
    await missing.init();
    assert.equal((await missing.check({ manual: true })).update.installMode, "page");
    const wrongType = feed();
    wrongType.files["linux-x64"].name = "Autochart-0.3.0.exe";
    const mismatched = updater(await tempDir(), { feedText: signed(wrongType) }).instance;
    await mismatched.init();
    assert.equal((await mismatched.check({ manual: true })).update.installMode, "page");
    await assert.rejects(mismatched.fetchUpdate(), /download page/);
  }

  // Download, re-check before install, and stale download cleanup.
  {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, "Updates"));
    await fs.writeFile(path.join(dir, "Updates", "Autochart-0.2.5-linux-x86_64.AppImage"), "old");
    const { instance } = updater(dir);
    await instance.init();
    await assert.rejects(instance.readyFile(), /Download the update first/);
    await instance.check({ manual: true });
    const state = await instance.fetchUpdate();
    assert.equal(state.download.status, "ready");
    assert.deepEqual(await fs.readdir(path.join(dir, "Updates")), ["Autochart-0.3.0-linux-x86_64.AppImage"]);
    const file = await instance.readyFile();
    await fs.writeFile(file, "changed");
    await assert.rejects(instance.readyFile(), /changed on disk/);
    assert.equal(instance.snapshot().download.status, "failed");
  }

  // The release picture downloads with the check and is re-checked when read.
  {
    const dir = await tempDir();
    const picture = { name: "hero.png", url: "https://example.com/hero.png", size: BYTES.length, sha256: SHA };
    const { instance } = updater(dir, { feedText: signed(feed({ headline: "Big one", image: picture })) });
    await instance.init();
    const state = await instance.check({ manual: true });
    assert.equal(state.update.headline, "Big one");
    assert.equal(state.update.hasImage, true);
    assert.equal(await instance.imageDataUrl(), `data:image/png;base64,${BYTES.toString("base64")}`);
    assert.equal((await updater(dir).instance.init()).update.hasImage, true);
    await instance.fetchUpdate();
    assert.deepEqual((await fs.readdir(path.join(dir, "Updates"))).sort(), ["Autochart-0.3.0-linux-x86_64.AppImage", "hero.png"]);
    await fs.writeFile(path.join(dir, "Updates", "hero.png"), "changed");
    assert.equal(await instance.imageDataUrl(), "");
    assert.equal(instance.snapshot().update.hasImage, false);
  }

  // AppImage swap keeps the path and makes it executable.
  {
    const dir = await tempDir();
    const appImage = path.join(dir, "Autochart.AppImage");
    const download = path.join(dir, "download.AppImage");
    await fs.writeFile(appImage, "old");
    await fs.writeFile(download, BYTES);
    await replaceAppImage(download, appImage);
    assert.deepEqual(await fs.readFile(appImage), BYTES);
    assert.equal((await fs.stat(appImage)).mode & 0o777, 0o755);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["Autochart.AppImage", "download.AppImage"]);
  }

  // The release script signs a feed the app accepts.
  {
    const dir = await tempDir();
    const names = [
      "Autochart-0.3.0-linux-x86_64.AppImage",
      "Autochart-0.3.0-win-x64.exe",
      "Autochart-0.3.0-win-x64.zip",
      "Autochart-0.3.0-arm64.dmg",
    ];
    const sums = [];
    for (const name of names) {
      const bytes = Buffer.from(name);
      await fs.writeFile(path.join(dir, name), bytes);
      sums.push(`${crypto.createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
    await fs.writeFile(path.join(dir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
    await fs.writeFile(path.join(dir, "hero.webp"), BYTES);
    const { text } = await makeUpdateFeed({
      dir,
      notes: { headline: "Big", features: [{ title: "One", text: "Line." }], fixes: ["Fix"], image: "hero.webp" },
      privateKeyPem: PRIVATE,
      version: "0.3.0",
    });
    const verified = verifyFeed(text, PUBLIC).feed;
    assert.equal(verified.headline, "Big");
    assert.equal(verified.image.sha256, SHA);
    assert.match(verified.image.url, /\/download\/v0\.3\.0\/hero\.webp$/);
    assert.deepEqual(Object.keys(verified.files).sort(), ["darwin-arm64", "linux-x64", "win32-x64"]);
    assert.equal(verified.files["win32-x64"].name, "Autochart-0.3.0-win-x64.exe");
    assert.equal(verified.files["darwin-arm64"].size, Buffer.byteLength("Autochart-0.3.0-arm64.dmg"));
    assert.match(verified.page, /\/releases\/tag\/v0\.3\.0$/);
    assert.equal(verified.notesUrl, verified.page);
    assert.deepEqual(verified.fixes, ["Fix"]);
    await assert.rejects(
      makeUpdateFeed({ dir: await tempDir(), privateKeyPem: PRIVATE, version: "0.3.0" }),
      /ENOENT/
    );
  }

  console.log("App update checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => root && fs.rm(root, { recursive: true, force: true }));
