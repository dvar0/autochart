#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  assertBundledLicenses,
  collectPackagedDistAllowlist,
  isAllowedAppFile,
} = require("./assert-package-contents.cjs");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-dist-allowlist-"));
  try {
    const appDir = path.join(root, "app");
    const assetsDir = path.join(appDir, "dist", "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "dist", "index.html"), '<script type="module" src="/assets/index-abcdef12.js"></script>');
    await fs.writeFile(path.join(appDir, "dist", "app-icon.svg"), "<svg></svg>");
    await fs.writeFile(path.join(appDir, "dist", "app-icon.png"), Buffer.from([0]));
    await fs.writeFile(path.join(assetsDir, "index-abcdef12.js"), "console.log('ok');");

    const allowlist = collectPackagedDistAllowlist(appDir);
    assert(allowlist.has("dist/index.html"));
    assert(allowlist.has("dist/assets/index-abcdef12.js"));
    assert.equal(isAllowedAppFile("dist/assets/index-abcdef12.js", "linux", "x64", allowlist), true);
    assert.equal(isAllowedAppFile("dist/extra.js", "linux", "x64", allowlist), false);
    assert.equal(isAllowedAppFile("shared/finalSlots.js", "linux", "x64", allowlist), true);
    assert.equal(isAllowedAppFile("engine/lib/chartTiming.cjs", "linux", "x64", allowlist), true);
    assert.equal(isAllowedAppFile("dist/assets/index-abcdef12.js.map", "linux", "x64", allowlist), false);

    await fs.writeFile(path.join(assetsDir, "evil.js"), "console.log('unexpected');");
    await fs.writeFile(path.join(appDir, "dist", "index.html"), '<script src="/assets/evil.js"></script>');
    assert.throws(() => collectPackagedDistAllowlist(appDir), /Unexpected packaged dist file/);
    await fs.writeFile(path.join(appDir, "dist", "evil.js"), "console.log('public diagnostic');");
    await fs.writeFile(path.join(appDir, "dist", "index.html"), '<script src="/evil.js"></script>');
    assert.throws(() => collectPackagedDistAllowlist(appDir), /Unexpected packaged dist file/);
    await fs.writeFile(path.join(assetsDir, "index-abcdef12.js.map"), "{}");
    assert.equal(isAllowedAppFile("dist/assets/index-abcdef12.js.map", "linux", "x64", allowlist), false);
    const engineDir = path.join(appDir, "engine");
    const catalogPath = path.join(engineDir, "catalog.json");
    await fs.mkdir(engineDir, { recursive: true });
    await fs.copyFile(path.join(__dirname, "../engine/catalog.json"), catalogPath);
    await fs.cp(path.join(__dirname, "../engine/licenses"), path.join(engineDir, "licenses"), { recursive: true });
    assertBundledLicenses(appDir);
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    const license = catalog.components.flatMap((component) => component.files || [])
      .find((file) => file.source === "bundled-license");
    const licensePath = path.join(engineDir, license.path);
    const original = await fs.readFile(licensePath, "utf8");
    await fs.writeFile(licensePath, original.replace(/\r?\n/g, "\r\n"));
    assert.throws(() => assertBundledLicenses(appDir), /mismatch/, "CRLF checkout must fail pinned license verification");
    await fs.writeFile(licensePath, original);
    await fs.writeFile(licensePath, original.replace(/[^\r\n]/, (letter) => letter === "x" ? "y" : "x"));
    assert.throws(() => assertBundledLicenses(appDir), /mismatch/, "same-length tampering must fail the hash pin");
    await fs.writeFile(licensePath, original);
    const validPath = license.path;
    for (const invalidPath of [path.basename(validPath), "licenses/..", "licenses/../escape", "licenses/dir/file", "licenses/back\\slash"]) {
      license.path = invalidPath;
      await fs.writeFile(catalogPath, JSON.stringify(catalog));
      assert.throws(() => assertBundledLicenses(appDir), /Bundled license path/);
    }
    await fs.writeFile(catalogPath, JSON.stringify({ components: [] }));
    assert.throws(() => assertBundledLicenses(appDir), /does not pin/);
    console.log("packaged dist allowlist and pinned license checks passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
