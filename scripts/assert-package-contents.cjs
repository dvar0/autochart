"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  assertPinnedFileSync,
  manifest,
  sha256FileSync,
  targetArch,
  targetSpecification,
} = require("./verify-runtime-artifacts.cjs");

const NODE_VERSION = manifest.node.version;
const PROJECT_ROOT = path.join(__dirname, "..");
const TAR_BUNDLE_COMPONENTS = [
  { name: "tar", version: "7.5.22", license: "BlueOak-1.0.0", packagePath: "node_modules/tar/package.json" },
  {
    name: "@isaacs/fs-minipass",
    version: "4.0.1",
    license: "ISC",
    packagePath: "node_modules/@isaacs/fs-minipass/package.json",
  },
  { name: "minipass", version: "7.1.3", license: "BlueOak-1.0.0", packagePath: "node_modules/minipass/package.json" },
  { name: "minizlib", version: "3.1.0", license: "MIT", packagePath: "node_modules/minizlib/package.json" },
  { name: "chownr", version: "3.0.0", license: "BlueOak-1.0.0", packagePath: "node_modules/chownr/package.json" },
  {
    name: "yallist",
    version: "5.0.0",
    license: "BlueOak-1.0.0",
    packagePath: "node_modules/tar/node_modules/yallist/package.json",
  },
];
const TAR_BUNDLE_NOTICES = [
  {
    bundledName: "@isaacs/fs-minipass",
    checkedInPath: "docs/fs-minipass-isc.txt",
    upstreamPath: "node_modules/@isaacs/fs-minipass/LICENSE",
  },
  {
    bundledName: "minizlib",
    checkedInPath: "docs/minizlib-mit.txt",
    upstreamPath: "node_modules/minizlib/LICENSE",
  },
];

function assertPackageMetadata(packagePath, expected, label) {
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  for (const field of ["name", "version", "license"]) {
    if (metadata[field] !== expected[field]) {
      throw new Error(
        `${label} ${field} mismatch: expected ${expected[field]}, received ${metadata[field] || "missing"}.`
      );
    }
  }
}

function assertExactCopy(sourcePath, destinationPath, label) {
  const sourceStat = fs.lstatSync(sourcePath);
  assertPinnedFileSync(destinationPath, {
    size: sourceStat.size,
    sha256: sha256FileSync(sourcePath),
  }, label);
}

function assertBundledLicenses(appDir) {
  const catalog = JSON.parse(fs.readFileSync(path.join(appDir, "engine", "catalog.json"), "utf8"));
  const bundledLicenses = [];
  for (const component of Array.isArray(catalog.components) ? catalog.components : []) {
    for (const file of Array.isArray(component.files) ? component.files : []) {
      if (file?.source === "bundled-license") bundledLicenses.push(file);
    }
  }
  if (!bundledLicenses.length) {
    throw new Error("Engine catalog does not pin any bundled licenses.");
  }
  for (const file of bundledLicenses) {
    const name = path.posix.basename(String(file.path || ""));
    if (!/^licenses\/[^/\\]+$/.test(String(file.path || "")) || name === "." || name === "..") {
      throw new Error(`Bundled license path is not a licenses/ file: ${file.path}`);
    }
    const expected = { size: file.size, sha256: file.sha256 };
    assertPinnedFileSync(
      path.join(PROJECT_ROOT, "engine", "licenses", name),
      expected,
      `Checkout bundled license ${file.path}`
    );
    assertPinnedFileSync(
      path.join(appDir, "engine", "licenses", name),
      expected,
      `Packaged bundled license ${file.path}`
    );
  }
}

function walkFiles(root) {
  const files = [];
  function visit(relativeDir) {
    const directory = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDir, entry.name).split(path.sep).join("/");
      const absolute = path.join(root, relative);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Packaged content must not contain symlinks: ${relative}`);
      if (stat.isDirectory()) visit(relative);
      else if (stat.isFile()) files.push(relative);
      else throw new Error(`Unsupported packaged filesystem entry: ${relative}`);
    }
  }
  visit("");
  return files.sort();
}

const VITE_ASSET_PATTERN =
  /^dist\/assets\/(?:index|note-cap|(?:baloo-2|inter|jetbrains-mono)-latin-(?:400|500|600|700|800)(?:-normal|-italic)?)-[A-Za-z0-9_-]{8,64}\.(?:js|css|woff2|woff|ttf|png|svg|webp|wasm)$/;

function isAllowedViteAsset(relative) {
  return VITE_ASSET_PATTERN.test(relative);
}
const PACKAGED_DIST_ROOT_FILES = new Set([
  "dist/index.html",
  "dist/app-icon.svg",
  "dist/app-icon.png",
]);

function isAllowedPackagedDistFile(relative) {
  return PACKAGED_DIST_ROOT_FILES.has(relative) || isAllowedViteAsset(relative);
}

function resolvePackagedDistReference(fromRelative, reference, appDir) {
  const raw = String(reference || "").trim().split(/[?#]/, 1)[0];
  if (!raw || raw.startsWith("data:") || raw.startsWith("http:") || raw.startsWith("https:")) return null;
  const withoutLeadingSlash = raw.replace(/^\/+/, "");
  const candidate = path.posix.normalize(
    withoutLeadingSlash.startsWith("dist/")
      ? withoutLeadingSlash
      : path.posix.join(path.posix.dirname(fromRelative), withoutLeadingSlash)
  );
  if (!candidate.startsWith("dist/") || candidate.includes("/../") || candidate === "dist/") return null;
  const absolute = path.join(appDir, ...candidate.split("/"));
  return fs.existsSync(absolute) && fs.lstatSync(absolute).isFile() ? candidate : null;
}
function collectPackagedDistAllowlist(appDir) {
  const required = new Set(PACKAGED_DIST_ROOT_FILES);
  const queue = [...required];
  while (queue.length) {
    const relative = queue.shift();
    if (relative.toLowerCase().endsWith(".map")) {
      throw new Error(`Packaged dist source maps are forbidden: ${relative}`);
    }
    const absolute = path.join(appDir, ...relative.split("/"));
    if (!fs.existsSync(absolute)) {
      throw new Error(`Packaged dist output is missing required file: ${relative}`);
    }
    let source;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    const references = new Set();
    const referencePattern = /(?:src|href)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"')\s]+)|["'`](\/?(?:assets|app-icon\.)[^"'`]+)["'`]/gi;
    for (const match of source.matchAll(referencePattern)) {
      const reference = match[1] || match[2] || match[3];
      const resolved = resolvePackagedDistReference(relative, reference, appDir);
      if (resolved && !isAllowedPackagedDistFile(resolved)) {
        throw new Error(`Unexpected packaged dist file: ${resolved}`);
      }
      if (resolved) references.add(resolved);
    }
    for (const resolved of references) {
      if (!required.has(resolved)) {
        required.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return required;
}

function findResourcesDir(appOutDir) {
  const direct = path.join(appOutDir, "resources");
  if (fs.existsSync(path.join(direct, "app", "package.json"))) return direct;
  for (const entry of fs.readdirSync(appOutDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const candidate = path.join(appOutDir, entry.name, "Contents", "Resources");
    if (fs.existsSync(path.join(candidate, "app", "package.json"))) return candidate;
  }
  throw new Error(`Could not locate unpacked app resources under ${appOutDir}`);
}

function isAllowedAppFile(relative, platform, arch, distAllowlist = new Set()) {
  const exact = new Set([
    "LICENSE",
    "package.json",
    "config/supported-targets.json",
    "config/supported-targets.cjs",
    "engine/catalog.json",
    "engine/manifest.json",
    "config/human-labels.json",
    "config/human-labels.cjs",
    "shared/chartWriter.cjs",
    "shared/generatedVersion.js",
    "shared/chartProvenance.js",
    "shared/finalSlots.js",
    "engine/lib/generationStages.cjs",
    "engine/lib/chartTiming.cjs",
    "engine/lib/finishProcess.cjs",
    "engine/lib/onnx/package.json",
    "engine/licenses/beat-this-mit.txt",
    "engine/licenses/cc-by-nc-sa-4.0.txt",
    "engine/licenses/demucs-mit.txt",
    "engine/licenses/model-pack-attribution.txt",
    "docs/blueoak-1.0.0.txt",
    "docs/fs-minipass-isc.txt",
    "docs/lgpl-2.1.txt",
    "docs/xiph-bsd.txt",
    "docs/libvpx-bsd.txt",
    "docs/dav1d-bsd.txt",
    "docs/minizlib-mit.txt",
    "docs/onnxruntime-third-party-notices.txt",
    "docs/third-party-notices.md",
    "docs/privacy.md",
    "docs/release-notes.md",
    "docs/install.md",
    "node_modules/onnxruntime-node/package.json",
    "node_modules/onnxruntime-common/package.json",
    "node_modules/onnxruntime-common/dist/cjs/package.json",
    "node_modules/tar/package.json",
    "node_modules/tar/dist/commonjs/index.min.js",
    "node_modules/tar/dist/commonjs/package.json",
    "node_modules/yauzl/package.json",
    "node_modules/yauzl/index.js",
    "node_modules/yauzl/fd-slicer.js",
    "node_modules/yauzl/crc32.js",
    "node_modules/pend/package.json",
    "node_modules/pend/index.js",
  ]);
  if (exact.has(relative)) return true;
  if (relative.startsWith("dist/")) return isAllowedPackagedDistFile(relative) && distAllowlist.has(relative);
  if (/^electron\/[^/]+\.cjs$/.test(relative)) return true;
  if (/^engine\/bin\/[^/]+\.cjs$/.test(relative)) return true;
  if (/^engine\/lib\/onnx\/[^/]+\.cjs$/.test(relative)) return true;
  if (/^node_modules\/onnxruntime-node\/dist\/[^/]+\.js$/.test(relative)) return true;
  if (/^node_modules\/onnxruntime-common\/dist\/cjs\/[^/]+\.js$/.test(relative)) return true;
  return relative.startsWith(`node_modules/onnxruntime-node/bin/napi-v6/${platform}/${arch}/`);
}

function assertCommand(executable, args, expectedText, label) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.status !== 0 || (expectedText && !output.includes(expectedText))) {
    throw new Error(`${label} failed (exit ${result.status}): ${output || result.error?.message || "no output"}`);
  }
}

function assertPinnedExecutable({ filePath, expected, label, platform, arch, phase, versionArgs, versionText }) {
  try {
    assertPinnedFileSync(filePath, expected, label);
    return "exact pinned bytes";
  } catch (pinnedError) {
    if (platform !== "darwin" || phase !== "post-sign") throw pinnedError;
    if (process.platform !== "darwin" || arch !== process.arch) {
      throw new Error(
        `${label} differs from its pinned pre-sign bytes, and its macOS signature cannot be verified on ` +
        `${process.platform}-${process.arch}. Original error: ${pinnedError.message}`
      );
    }
    assertCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", filePath], null, `${label} code signature`);
    assertCommand(filePath, versionArgs, versionText, `${label} version check`);
    return "verified post-sign macOS bytes";
  }
}

function assertPackageContents({
  appOutDir,
  platform = process.platform,
  arch = process.arch,
  phase = "post-sign",
}) {
  if (phase !== "pre-sign" && phase !== "post-sign") {
    throw new Error(`Unknown artifact verification phase: ${phase}`);
  }
  const normalizedArch = targetArch(arch);
  const { specification: nodeSpecification } = targetSpecification("node", platform, normalizedArch);
  const { specification: ffmpegSpecification } = targetSpecification("ffmpeg", platform, normalizedArch);
  if (platform === "win32") {
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    const signExts = sourcePackage.build?.win?.signExts;
    const requiredExclusions = ["!node.exe", "!ffmpeg.exe"];
    if (JSON.stringify(signExts) !== JSON.stringify(requiredExclusions)) {
      throw new Error(
        "Windows packaging must preserve exact hash-pinned runtime bytes with build.win.signExts set only to " +
        `${JSON.stringify(requiredExclusions)}.`
      );
    }
  }
  const resourcesDir = findResourcesDir(path.resolve(appOutDir));
  const appDir = path.join(resourcesDir, "app");
  const distAllowlist = collectPackagedDistAllowlist(appDir);
  const appFiles = walkFiles(appDir);
  const unexpected = appFiles.filter((relative) => !isAllowedAppFile(
    relative,
    platform,
    normalizedArch,
    distAllowlist
  ));
  if (unexpected.length) {
    throw new Error(`Unexpected packaged app files:\n${unexpected.map((file) => `  ${file}`).join("\n")}`);
  }

  const appLicense = path.join(appDir, "LICENSE");
  if (!appFiles.includes("LICENSE")) throw new Error("Packaged app is missing its AGPL LICENSE.");
  const sourceLicense = path.join(PROJECT_ROOT, "LICENSE");
  const sourceLicenseStat = fs.lstatSync(sourceLicense);
  assertPinnedFileSync(appLicense, {
    size: sourceLicenseStat.size,
    sha256: sha256FileSync(sourceLicense),
  }, "Packaged Autochart AGPL license");
  if (!fs.readFileSync(appLicense, "utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")) {
    throw new Error("Packaged Autochart LICENSE is not the expected GNU Affero GPL text.");
  }

  for (const component of TAR_BUNDLE_COMPONENTS) {
    assertPackageMetadata(
      path.join(PROJECT_ROOT, component.packagePath),
      component,
      `Bundled tar component ${component.name}`
    );
  }
  assertPackageMetadata(
    path.join(appDir, "node_modules", "tar", "package.json"),
    TAR_BUNDLE_COMPONENTS[0],
    "Packaged tar runtime"
  );
  for (const notice of TAR_BUNDLE_NOTICES) {
    const upstreamPath = path.join(PROJECT_ROOT, notice.upstreamPath);
    const checkedInPath = path.join(PROJECT_ROOT, notice.checkedInPath);
    assertExactCopy(upstreamPath, checkedInPath, `Checked-in ${notice.bundledName} notice`);
    assertExactCopy(upstreamPath, path.join(appDir, notice.checkedInPath), `Packaged ${notice.bundledName} notice`);
  }
  const blueOakPath = path.join(PROJECT_ROOT, "docs", "blueoak-1.0.0.txt");
  const blueOakText = fs.readFileSync(blueOakPath, "utf8");
  if (!blueOakText.includes("Blue Oak Model License") ||
      !blueOakText.includes("Version 1.0.0") ||
      !blueOakText.includes("https://blueoakcouncil.org/license/1.0.0")) {
    throw new Error("Packaged Blue Oak notice is not the complete version 1.0.0 license text.");
  }
  assertExactCopy(blueOakPath, path.join(appDir, "docs", "blueoak-1.0.0.txt"), "Packaged Blue Oak notice");
  for (const notice of ["lgpl-2.1.txt", "xiph-bsd.txt", "libvpx-bsd.txt", "dav1d-bsd.txt"]) {
    assertExactCopy(path.join(PROJECT_ROOT, "docs", notice), path.join(appDir, "docs", notice), `Packaged FFmpeg/Xiph notice ${notice}`);
  }

  assertBundledLicenses(appDir);
  for (const helper of ["shared/finalSlots.js", "shared/chartProvenance.js", "engine/lib/chartTiming.cjs"]) {
    assertExactCopy(path.join(PROJECT_ROOT, helper), path.join(appDir, helper), `Packaged helper ${helper}`);
  }

  const nativePrefix = "node_modules/onnxruntime-node/bin/napi-v6/";
  const nativeFiles = appFiles.filter((relative) => relative.startsWith(nativePrefix));
  if (!nativeFiles.length) throw new Error("Packaged app does not contain ONNX Runtime native files.");
  const wrongNativeFiles = nativeFiles.filter(
    (relative) => !relative.startsWith(`${nativePrefix}${platform}/${normalizedArch}/`)
  );
  if (wrongNativeFiles.length) {
    throw new Error(`Packaged app contains ONNX Runtime files for another target:\n${wrongNativeFiles.join("\n")}`);
  }

  for (const forbidden of ["engine/test/", "engine/models-onnx/", "scripts/", "fixtures/", "src/", "public/"]) {
    if (appFiles.some((relative) => relative.startsWith(forbidden))) {
      throw new Error(`Packaged app contains forbidden development content: ${forbidden}`);
    }
  }

  const resourceFiles = walkFiles(resourcesDir);
  const externalFiles = resourceFiles.filter((relative) => !relative.startsWith("app/"));
  const expectedFfmpeg = `ffmpeg/${ffmpegSpecification.executableName}`;
  const nodeRelative = `node-runtime/${nodeSpecification.executableName}`;
  const nodeLicenseRelative = "node-runtime/LICENSE";
  const allowedExternal = externalFiles.filter((relative) =>
    relative === expectedFfmpeg ||
    relative === "ffmpeg/build.json" ||
    relative === nodeRelative ||
    relative === nodeLicenseRelative ||
    (platform === "darwin" && /^[^/]+\.icns$/.test(relative))
  );
  if (allowedExternal.length !== externalFiles.length) {
    const allowed = new Set(allowedExternal);
    throw new Error(`Unexpected packaged resources:\n${externalFiles.filter((file) => !allowed.has(file)).join("\n")}`);
  }

  const ffmpegFiles = resourceFiles.filter((relative) => /(^|\/)ffmpeg(?:\.exe)?$/.test(relative));
  if (ffmpegFiles.length !== 1 || ffmpegFiles[0] !== expectedFfmpeg) {
    throw new Error(`Expected exactly one bundled FFmpeg executable at ${expectedFfmpeg}; found: ${ffmpegFiles.join(", ") || "none"}`);
  }
  const ffmpegExecutable = path.join(resourcesDir, expectedFfmpeg);
  const ffmpegBuild = require("./prepare-ffmpeg.cjs").readBuild({ projectDir: PROJECT_ROOT, platform, arch: normalizedArch });
  assertExactCopy(path.join(ffmpegBuild.directory, "build.json"), path.join(resourcesDir, "ffmpeg/build.json"), "FFmpeg build receipt");
  const ffmpegVerification = assertPinnedExecutable({
    filePath: ffmpegExecutable,
    expected: {
      size: ffmpegBuild.executableSize,
      sha256: ffmpegBuild.executableSha256,
    },
    label: "Bundled FFmpeg executable",
    platform,
    arch: normalizedArch,
    phase,
    versionArgs: ["-version"],
    versionText: ffmpegSpecification.versionText,
  });

  const nodeExecutable = path.join(resourcesDir, nodeRelative);
  const nodeVerification = assertPinnedExecutable({
    filePath: nodeExecutable,
    expected: {
      size: nodeSpecification.executableSize,
      sha256: nodeSpecification.executableSha256,
    },
    label: "Bundled Node executable",
    platform,
    arch: normalizedArch,
    phase,
    versionArgs: ["--version"],
    versionText: `v${NODE_VERSION}`,
  });
  assertPinnedFileSync(path.join(resourcesDir, nodeLicenseRelative), {
    size: nodeSpecification.licenseSize,
    sha256: nodeSpecification.licenseSha256,
  }, "Bundled Node license and third-party notices");

  if (platform === process.platform && normalizedArch === process.arch) {
    assertCommand(nodeExecutable, ["--version"], `v${NODE_VERSION}`, "Bundled Node version check");
    const ortPackage = path.join(appDir, "node_modules", "onnxruntime-node");
    assertCommand(
      nodeExecutable,
      ["-e", `const ort=require(${JSON.stringify(ortPackage)});const names=ort.listSupportedBackends().filter(x=>x.bundled).map(x=>x.name);if(!names.includes('cpu')||!names.includes('webgpu'))process.exit(2);console.log('cpu-webgpu-ok:'+names.join(','))`],
      "cpu-webgpu-ok",
      "Packaged ONNX Runtime backend check"
    );
    const installerModule = path.join(appDir, "electron", "assetInstaller.cjs");
    assertCommand(
      nodeExecutable,
      ["-e", `require(${JSON.stringify(installerModule)});console.log('installer-runtime-ok')`],
      "installer-runtime-ok",
      "Packaged installer dependency check"
    );
    assertCommand(ffmpegExecutable, ["-version"], ffmpegSpecification.versionText, "Bundled FFmpeg check");
  }

  console.log(
    `Artifact allowlist passed: ${appFiles.length} app files, ${nativeFiles.length} target ONNX files, ` +
    `FFmpeg (${ffmpegVerification}), Node v${NODE_VERSION} (${nodeVerification}), and required licenses.`
  );
  return { appFiles: appFiles.length, nativeFiles: nativeFiles.length, resourcesDir };
}

module.exports = (context) => assertPackageContents({
  appOutDir: context.appOutDir,
  platform: context.electronPlatformName,
  arch: context.arch,
  phase: "pre-sign",
});
module.exports.assertPackageContents = assertPackageContents;
module.exports.assertBundledLicenses = assertBundledLicenses;
module.exports.collectPackagedDistAllowlist = collectPackagedDistAllowlist;
module.exports.isAllowedAppFile = isAllowedAppFile;

if (require.main === module) {
  const appOutDir = process.argv[2] || path.join("release", "linux-unpacked");
  const platform = process.argv[3] || process.platform;
  const arch = process.argv[4] || process.arch;
  const phase = process.argv[5] || "post-sign";
  try {
    assertPackageContents({ appOutDir, platform, arch, phase });
  } catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}
