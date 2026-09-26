#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { assertPackageContents } = require("./assert-package-contents.cjs");
const { assertPublicSourceState } = require("./create-source-release.cjs");
const { inspectFfmpegSourceArchive } = require("./ffmpeg-source-gate.cjs");
const smokePathSafety = require("./smoke-path-safety.cjs");
const { SUPPORTED_TARGETS } = require("../config/supported-targets.cjs");

const ROOT = path.resolve(__dirname, "..");
const RELEASE_DIR = path.join(ROOT, "release");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const UNSIGNED_NOTICE_NAME = "UNSIGNED-RELEASE.txt";
const ISOLATED_PATHS = Object.freeze([
  { key: "userData", role: "user-data", leaf: "user-data" },
  { key: "modelsFolder", role: "models", leaf: "models" },
  { key: "cacheFolder", role: "cache", leaf: "cache" },
  { key: "projectsFolder", role: "projects", leaf: "projects" },
]);

class CommandError extends Error {
  constructor(label, command, args, code, signal) {
    super(
      `${label} failed: ${command} ${args.join(" ")} ` +
      `(exit ${code == null ? "none" : code}${signal ? `, signal ${signal}` : ""})`
    );
    this.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
  }
}

function usage() {
  return `
Usage: npm run release:verify -- [options]

Runs every mandatory release gate, once, in fail-fast order. There are no
--skip-* options: a default verification never omits a named gate.

Options:
  --clean-install          Reinstall assets into new, marker-owned isolated paths.
                           Pre-existing explicit paths are rejected, never deleted.
  --models-folder <path>   Override the models path used by every generation gate.
  --user-data <path>       Override isolated userData for the generation smoke.
  --cache-folder <path>    Override isolated cache for generation smoke gates.
  --projects-folder <path> Override isolated projects storage for the smoke.
  --audio <path>           Audio fixture for both generation smoke gates.
  --hardware <mode>        auto, cuda, webgpu, coreml, or cpu (default: auto).
  --public-release         Enforce public source, licensing, and FFmpeg-source gates.
                           Artifacts remain unsigned unless --require-signing is also set.
  --require-signing        Additionally require and verify paid platform signing/notarization.
                           Valid only together with --public-release.
  --help                   Show this help.

AUTOCHART_ASSETS_BASE_URL supplies the model host without placing it in process
arguments or logs. Target-native packaging is selected from the host OS/arch.

The post-package gate uses the artifact's bundled Node, engine, and ONNX Runtime.
Selected hardware is covered pre-package; packaged integrity smoke is CPU-pinned for deterministic target-native verification.
`.trim();
}

function parseArgs(argv) {
  const args = {
    cleanInstall: false,
    publicRelease: false,
    requireSigning: false,
    modelsFolder: "",
    userData: "",
    cacheFolder: "",
    projectsFolder: "",
    audio: "",
    hardware: "auto",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--clean-install") args.cleanInstall = true;
    else if (arg === "--public-release") args.publicRelease = true;
    else if (arg === "--require-signing") args.requireSigning = true;
    else if (arg === "--models-folder") {
      args.modelsFolder = path.resolve(next());
    } else if (arg === "--user-data") {
      args.userData = path.resolve(next());
    } else if (arg === "--cache-folder") {
      args.cacheFolder = path.resolve(next());
    } else if (arg === "--projects-folder") {
      args.projectsFolder = path.resolve(next());
    }
    else if (arg === "--audio") args.audio = path.resolve(next());
    else if (arg === "--hardware") args.hardware = String(next());
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["auto", "cuda", "webgpu", "coreml", "cpu"].includes(args.hardware)) {
    throw new Error("--hardware must be auto, cuda, webgpu, coreml, or cpu.");
  }
  if (args.requireSigning && !args.publicRelease) {
    throw new Error("--require-signing is valid only together with --public-release.");
  }
  return args;
}

function nativeTarget() {
  const target = SUPPORTED_TARGETS.find(
    (candidate) => candidate.platform === process.platform && candidate.arch === process.arch
  );
  if (!target) {
    throw new Error(
      `Release verification requires a native configured target; got ${process.platform}-${process.arch}.`
    );
  }
  return {
    ...target,
    builderArgs: [...(target.builderArgs || [])],
    appOutCandidates: [...(target.appOutCandidates || [])],
  };
}

function run(label, command, args, options = {}) {
  if (command === NPM && process.platform === "win32") {
    // Windows cannot spawn .cmd files directly. Run npm's JS entry point with
    // Node, keeping paths/arguments out of a command shell.
    const npmCli = process.env.npm_execpath || path.join(
      path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"
    );
    if (!fsSync.existsSync(npmCli)) {
      throw new Error("Cannot locate npm-cli.js; invoke this verifier with npm run release:verify.");
    }
    args = [npmCli, ...args];
    command = process.execPath;
  }
  const displayArgs = options.displayArgs || args;
  console.log(`\n[release] ${label}`);
  console.log(`[release] $ ${command} ${displayArgs.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new CommandError(label, command, displayArgs, code, signal));
    });
  });
}

function runNode(label, relativeScript, args = []) {
  return run(label, process.execPath, [path.join(ROOT, relativeScript), ...args]);
}

function electronHarnessCommand(relativeScript, switches = []) {
  const electronExecutable = require("electron");
  const electronArgs = [...switches, path.join(ROOT, relativeScript)];
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return { command: "xvfb-run", args: ["-a", electronExecutable, ...electronArgs] };
  }
  return { command: electronExecutable, args: electronArgs };
}

function signingIdentityConfigured() {
  return Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
}

function unsignedPackagingEnvironment() {
  // spawn omits undefined values. Empty strings are still defined to Builder,
  // which resolves CSC_LINK="" to cwd and tries to import it as a certificate.
  return {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    CSC_LINK: undefined,
    CSC_NAME: undefined,
    CSC_KEY_PASSWORD: undefined,
    WIN_CSC_LINK: undefined,
    WIN_CSC_KEY_PASSWORD: undefined,
    APPLE_API_KEY: undefined,
    APPLE_API_KEY_ID: undefined,
    APPLE_API_ISSUER: undefined,
    APPLE_ID: undefined,
    APPLE_APP_SPECIFIC_PASSWORD: undefined,
    APPLE_TEAM_ID: undefined,
  };
}

function appleNotaryMode() {
  const apiKey = process.env.APPLE_API_KEY;
  const apiKeyId = process.env.APPLE_API_KEY_ID;
  const apiIssuer = process.env.APPLE_API_ISSUER;
  if (apiKey && apiKeyId && apiIssuer) {
    return { kind: "api-key", args: ["--key", apiKey, "--key-id", apiKeyId, "--issuer", apiIssuer] };
  }
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (appleId && password && teamId) {
    return { kind: "apple-id", args: ["--apple-id", appleId, "--password", password, "--team-id", teamId] };
  }
  return null;
}

function assertSigningEnvironment(target) {
  if (target.platform === "linux") return;
  if (!signingIdentityConfigured()) {
    throw new Error("--require-signing requires CSC_LINK or an installed CSC_NAME signing identity.");
  }
  if (process.env.CSC_LINK && !process.env.CSC_KEY_PASSWORD) {
    throw new Error("--require-signing with CSC_LINK requires CSC_KEY_PASSWORD.");
  }
  if (target.platform === "darwin" && !appleNotaryMode()) {
    throw new Error(
      "macOS --require-signing requires APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER " +
      "or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID."
    );
  }
}

function smokeArgs(options) {
  const args = [];
  if (options.cleanInstall) args.push("--wipe");
  args.push("--isolation-root", options.isolationRoot);
  if (options.modelsFolder) args.push("--models-folder", options.modelsFolder);
  if (options.userData) args.push("--user-data", options.userData);
  if (options.cacheFolder) args.push("--cache-folder", options.cacheFolder);
  if (options.projectsFolder) args.push("--projects-folder", options.projectsFolder);
  if (options.audio) args.push("--audio", options.audio);
  if (options.hardware) args.push("--hardware", options.hardware);
  return args;
}

function packagedGenerationArgs(appOutDir, target, options) {
  const args = [
    "--app-out",
    appOutDir,
    "--platform",
    target.platform,
    "--arch",
    target.arch,
    "--hardware",
    "cpu",
  ];
  if (options.modelsFolder) args.push("--models-folder", options.modelsFolder);
  if (options.audio) args.push("--audio", options.audio);
  if (options.cacheFolder) args.push("--scratch-root", path.join(options.cacheFolder, "packaged-generation"));
  return args;
}

function engineGateArgs(options) {
  const args = [];
  if (options.audio) args.push("--audio", options.audio);
  if (options.modelsFolder) args.push("--models-folder", options.modelsFolder);
  return args;
}

function looksLikeAppOut(dir) {
  if (fsSync.existsSync(path.join(dir, "resources", "app", "package.json"))) return true;
  try {
    return fsSync.readdirSync(dir, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() &&
      entry.name.endsWith(".app") &&
      fsSync.existsSync(path.join(dir, entry.name, "Contents", "Resources", "app", "package.json"))
    );
  } catch {
    return false;
  }
}

async function configureIsolatedPaths(options) {
  const isolation = await smokePathSafety.createIsolatedRunRoot("autochart-release-verify-");
  try {
    options.isolationRoot = isolation.root;
    options.isolationRunId = isolation.runId;
    for (const entry of ISOLATED_PATHS) {
      if (!options[entry.key]) options[entry.key] = path.join(isolation.root, entry.leaf);
    }
    const targets = ISOLATED_PATHS.map((entry) => ({ role: entry.role, target: options[entry.key] }));
    await smokePathSafety.validateDistinctTargets(targets);
    if (options.cleanInstall) {
      for (const entry of ISOLATED_PATHS) {
        if (await smokePathSafety.pathExists(options[entry.key])) {
          throw new Error(
            `--clean-install refuses the pre-existing ${entry.role} path: ${options[entry.key]}. ` +
            "Use a new empty path; release verification never deletes caller-owned directories."
          );
        }
      }
    }
    console.log(`[release] Isolated run root: ${isolation.root}`);
    return isolation;
  } catch (error) {
    await smokePathSafety.removeOwnedDirectory(isolation.root, {
      runId: isolation.runId,
      role: "run-root",
    }).catch(() => {});
    throw error;
  }
}

async function cleanupSuccessfulIsolation(options, isolation) {
  if (options.cleanInstall) {
    for (const entry of ISOLATED_PATHS) {
      const target = options[entry.key];
      if (smokePathSafety.isWithin(isolation.root, target) || !(await smokePathSafety.pathExists(target))) continue;
      await smokePathSafety.removeOwnedDirectory(target, {
        runId: isolation.runId,
        role: entry.role,
      });
    }
  }
  await smokePathSafety.removeOwnedDirectory(isolation.root, {
    runId: isolation.runId,
    role: "run-root",
  });
}

async function assertReleaseOutputClean() {
  let entries;
  try {
    entries = await fs.readdir(RELEASE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const artifactExtensions = new Set([
    ".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm", ".snap", ".zip", ".7z", ".blockmap",
  ]);
  const residue = [];
  for (const entry of entries) {
    const candidate = path.join(RELEASE_DIR, entry.name);
    const lower = entry.name.toLowerCase();
    if (entry.isFile()) {
      if (
        artifactExtensions.has(path.extname(lower)) ||
        /\.(?:tar\.gz|tar\.xz|tar\.zst|sha256)$/.test(lower) ||
        lower === "sha256sums.txt" ||
        lower === UNSIGNED_NOTICE_NAME.toLowerCase() ||
        (/latest/.test(lower) && /\.ya?ml$/.test(lower))
      ) {
        residue.push(entry.name);
      }
    } else if (entry.isDirectory() && (looksLikeAppOut(candidate) || /^artifact-check-/i.test(entry.name))) {
      residue.push(`${entry.name}/`);
    }
  }
  if (residue.length) {
    throw new Error(
      `Release output contains pre-existing artifacts: ${residue.sort().join(", ")}. ` +
      "Move them aside before verification; the verifier will not delete release output automatically."
    );
  }
}

async function stageUnsignedReleaseNotice(
  target,
  { releaseDir = RELEASE_DIR } = {}
) {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const noticePath = path.join(releaseDir, UNSIGNED_NOTICE_NAME);
  const text = [
    `Autochart ${manifest.version} public unsigned release`,
    `Target: ${target.platform}-${target.arch}`,
    "",
    "This application is intentionally not signed or notarized. Apple and Microsoft have not",
    "verified its publisher. Verify the downloaded binary against SHA256SUMS.txt before opening it.",
    "",
    "Windows: Microsoft Defender SmartScreen may show 'Windows protected your PC'. If you",
    "independently trust this download, choose More info, then Run anyway. Smart App Control",
    "or organizational policy may prevent installation.",
    "",
    "macOS: after the initial blocked launch, open System Settings > Privacy & Security and",
    "choose Open Anyway only if you independently trust and verified the download.",
    "",
    "Do not disable SmartScreen, Smart App Control, Gatekeeper, or other system-wide security",
    "controls. Source and licensing materials are published beside this binary.",
    "",
  ].join("\n");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(noticePath, text, { encoding: "utf8", flag: "wx" });
  console.log(`[release] Staged unsigned-install notice: ${noticePath}`);
  return noticePath;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function stageFfmpegCorrespondingSource(options, target) {
  const build = require("./prepare-ffmpeg.cjs").readBuild(target);
  await inspectFfmpegSourceArchive(build.sourceArchive, { target, build });
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const osName = target.platform === "win32" ? "windows" : target.platform === "darwin" ? "macos" : "linux";
  const fileName = `Autochart-${manifest.version}-${osName}-${target.arch}-ffmpeg-corresponding-source.tar.gz`;
  const destination = path.join(RELEASE_DIR, fileName);
  await fs.mkdir(RELEASE_DIR, { recursive: true });
  await fs.copyFile(build.sourceArchive, destination, fsSync.constants.COPYFILE_EXCL);
  if (await sha256File(destination) !== build.sourceSha256) throw new Error("Staged FFmpeg source checksum mismatch.");
  await fs.writeFile(`${destination}.sha256`, `${build.sourceSha256}  ${fileName}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`[release] Staged matching FFmpeg sources automatically: ${destination}`);
}

async function findAppOutDir(target) {
  for (const name of target.appOutCandidates) {
    const candidate = path.join(RELEASE_DIR, name);
    if (looksLikeAppOut(candidate)) return candidate;
  }
  let entries = [];
  try {
    entries = await fs.readdir(RELEASE_DIR, { withFileTypes: true });
  } catch {
    // The caller will receive the precise failure below.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(RELEASE_DIR, entry.name);
    if (looksLikeAppOut(candidate)) return candidate;
  }
  throw new Error(`Could not find packaged app output for ${target.platform}-${target.arch}.`);
}

async function releaseArtifacts(extension) {
  const entries = await fs.readdir(RELEASE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
    .map((entry) => path.join(RELEASE_DIR, entry.name))
    .sort();
}

async function verifyWindowsSignatures(appOutDir) {
  const installers = await releaseArtifacts(".exe");
  const files = [path.join(appOutDir, "Autochart.exe"), ...installers];
  if (files.some((file) => !fsSync.existsSync(file))) {
    throw new Error("Signed Windows executable or installer is missing.");
  }
  const quoted = files.map((file) => `'${file.replaceAll("'", "''")}'`).join(",");
  const script =
    `$files=@(${quoted});` +
    `foreach($file in $files){` +
    `$signature=Get-AuthenticodeSignature -LiteralPath $file;` +
    `if($signature.Status -ne 'Valid'){throw \"Invalid Authenticode signature: $file ($($signature.Status))\"};` +
    `if($null -eq $signature.TimeStamperCertificate){throw \"Authenticode signature is not timestamped: $file\"};` +
    `Write-Host \"Valid timestamped Authenticode signature: $file\"}`;
  await run("Verify Windows Authenticode signatures", "powershell.exe", ["-NoProfile", "-Command", script]);
}

async function verifyMacPublicDistribution(appOutDir) {
  const appName = (await fs.readdir(appOutDir)).find((name) => name.endsWith(".app"));
  if (!appName) throw new Error(`No .app bundle found under ${appOutDir}.`);
  const appPath = path.join(appOutDir, appName);
  await run("Verify Developer ID signature", "codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("Verify Gatekeeper assessment", "spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  await run("Verify stapled app ticket", "xcrun", ["stapler", "validate", appPath]);

  const notary = appleNotaryMode();
  const dmgs = await releaseArtifacts(".dmg");
  if (!dmgs.length) throw new Error("No DMG was produced for public macOS verification.");
  for (const dmg of dmgs) {
    await run(
      "Notarize DMG",
      "xcrun",
      ["notarytool", "submit", dmg, "--wait", ...notary.args],
      { displayArgs: ["notarytool", "submit", dmg, "--wait", "<notary-credentials>"] }
    );
    await run("Staple DMG ticket", "xcrun", ["stapler", "staple", dmg]);
    await run("Verify stapled DMG ticket", "xcrun", ["stapler", "validate", dmg]);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const target = nativeTarget();
  // macOS exposes /var through /private/var. Give every child harness canonical
  // scratch paths so strict anti-symlink gates test actual swaps, not this OS alias.
  if (target.platform === "darwin") {
    process.env.TMPDIR = await fs.realpath(require("os").tmpdir());
  }
  if (options.publicRelease) {
    const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
    await assertPublicSourceState(String(manifest.version || ""));
  }
  if (options.requireSigning) {
    assertSigningEnvironment(target);
  } else if (options.publicRelease) {
    console.warn(
      "[release] Public unsigned mode: platform trust warnings are expected; " +
      "source, license, integrity, and checksum gates remain mandatory."
    );
  }
  await assertReleaseOutputClean();
  await require("./prepare-ffmpeg.cjs").prepareFfmpeg({ rebuild: options.publicRelease });
  const isolation = await configureIsolatedPaths(options);
  let completed = false;
  try {
    await run(
      "Audit production dependencies",
      NPM,
      ["audit", "--omit=dev"],
      {
        env: {
          NPM_CONFIG_ALLOW_SCRIPTS: "",
          npm_config_allow_scripts: "",
        },
      }
    );
    await runNode("Installer/archive security harness", "scripts/test-asset-installer.cjs");
    await runNode("FFmpeg Corresponding Source security harness", "scripts/test-ffmpeg-source-gate.cjs");
    await runNode("Bundled FFmpeg audio behavior", "scripts/test-ffmpeg-audio.cjs");
    await runNode("Application security harness", "scripts/test-application-security.cjs");
    await runNode("Path-backed media persistence harness", "scripts/test-media-persistence.cjs");
    await runNode("Imported audio/video metadata", "scripts/test-media-metadata.cjs");
    await runNode("Final-container readiness harness", "scripts/test-release-smoke.cjs");
    await runNode("Smoke deletion-boundary harness", "scripts/test-smoke-path-safety.cjs");
    await runNode("Transactional export harness", "scripts/test-transactional-export.cjs");
    await runNode("Clone Hero export compatibility", "scripts/test-clone-hero-export.cjs");
    await runNode("Path-based generation IPC harness", "scripts/test-path-generation.cjs");
    await runNode("Engine process exit and event draining", "scripts/test-engine-process-exit.cjs");
    await runNode("v0.1.0 frontend contract harness", "scripts/test-v010-frontend.cjs");
    await runNode("v0.1.0 backend contract harness", "scripts/test-v010-backend.cjs");
    await runNode("Highway playback and streaming regressions", "scripts/test-highway.cjs");
    await runNode("Window auto-fit regressions", "scripts/test-window-fit.cjs");
    await runNode("Chart interoperability fixtures", "scripts/test-chart-interoperability.cjs");
    await runNode("Imported chart sync timing", "engine/test/source-chart-timing.cjs");
    await runNode("Imported chart timing stage and cache", "engine/test/source-chart-stage.cjs");
    await runNode("Chart metadata and AI provenance", "scripts/test-chart-metadata.cjs");
    await runNode("Imported final-chart assembly and persistence", "scripts/test-imported-final-chart.cjs");
    await runNode("Release documentation alignment", "scripts/test-release-docs.cjs");
    await runNode("Public download staging", "scripts/test-public-release-staging.cjs");
    await runNode("Notice path safety", "scripts/test-notice-paths.cjs");
    await runNode("Package allowlist regressions", "scripts/test-package-allowlist.cjs");
    await run("Production renderer build", NPM, ["run", "build"]);
    const mediaElectron = electronHarnessCommand("scripts/test-media-protocol-electron.cjs", ["--no-sandbox"]);
    await run(
      "Electron media CSP/CORS/range-streaming harness",
      mediaElectron.command,
      mediaElectron.args
    );
    const fullscreenElectron = electronHarnessCommand("scripts/test-owned-fullscreen-electron.cjs", ["--no-sandbox"]);
    await run("Electron fullscreen ownership regressions", fullscreenElectron.command, fullscreenElectron.args);
    await runNode("Electron system theme and preference persistence", "scripts/test-theme.cjs", ["--no-sandbox"]);
    const navigationElectron = electronHarnessCommand("scripts/test-generation-navigation.cjs", ["--no-sandbox"]);
    await run("Electron navigation, durable takes, and CPU recovery", navigationElectron.command, navigationElectron.args);
    const folderPromptElectron = electronHarnessCommand("scripts/test-library-folder-prompt-electron.cjs", ["--no-sandbox"]);
    await run("Electron songs-folder prompt from Library and Generate", folderPromptElectron.command, folderPromptElectron.args);
    const playbackElectron = electronHarnessCommand("scripts/test-highway-playback-electron.cjs", ["--no-sandbox"]);
    await run("Electron end-of-song playback", playbackElectron.command, playbackElectron.args);
    const releaseSmokeElectron = electronHarnessCommand(
      "scripts/test-release-smoke-electron.cjs",
      ["--no-sandbox"]
    );
    await run(
      "Electron preload/release-smoke IPC harness",
      releaseSmokeElectron.command,
      releaseSmokeElectron.args
    );

    await runNode(
      options.cleanInstall ? "Clean-install generation smoke" : "Generation smoke",
      "scripts/smoke-generate.cjs",
      smokeArgs(options)
    );
    await runNode("Engine gate 1/3: ONNX generation smoke", "engine/test/generate-onnx-smoke.cjs", engineGateArgs(options));
    await runNode("Engine gate 2/3: CFG batch parity", "engine/test/transcribe-cfg-batch-parity.cjs", engineGateArgs(options));
    await runNode("Engine gate 3/3: WebGPU parity", "engine/test/webgpu-parity.cjs", engineGateArgs(options));

    if (target.platform === "linux") {
      const noDriver = path.join(options.isolationRoot, "no-vulkan-driver.json");
      await run("No-adapter WebGPU to CPU fallback", process.execPath, [
        path.join(ROOT, "scripts/smoke-generate.cjs"),
        "--models-folder", options.modelsFolder,
        "--hardware", "webgpu", "--skip-install", "--expect-cpu-fallback",
        ...(options.audio ? ["--audio", options.audio] : []),
      ], { env: { VK_DRIVER_FILES: noDriver, VK_ICD_FILENAMES: noDriver } });
    }

    const builderArgs = [...target.builderArgs, "--publish", "never"];
    if (target.platform === "darwin") {
      builderArgs.push(options.requireSigning
        ? "--config.mac.notarize=true"
        : "--config.mac.identity=-");
    }
    await run(
      `Create ${target.platform}-${target.arch} package`,
      process.execPath,
      [require.resolve("electron-builder/cli.js"), ...builderArgs],
      options.requireSigning
        ? {}
        : { env: unsignedPackagingEnvironment() }
    );

    const appOutDir = await findAppOutDir(target);
    console.log(`\n[release] Artifact allowlist: ${appOutDir}`);
    assertPackageContents({ appOutDir, platform: target.platform, arch: target.arch });

    if (target.platform === "darwin") {
      const appName = (await fs.readdir(appOutDir)).find((name) => name.endsWith(".app"));
      if (!appName) throw new Error(`No .app bundle found under ${appOutDir}.`);
      // Even builds without Developer ID need a complete ad-hoc bundle seal.
      // Electron's leftover linker signature otherwise produces "damaged" on download.
      await run("Verify macOS bundle integrity", "codesign", [
        "--verify", "--deep", "--strict", "--verbose=2", path.join(appOutDir, appName),
      ]);
    }

    await runNode(
      "Packaged generation smoke (bundled Node/engine/ONNX Runtime)",
      "scripts/smoke-packaged-generation.cjs",
      packagedGenerationArgs(appOutDir, target, options)
    );

    if (options.requireSigning && target.platform === "win32") {
      await verifyWindowsSignatures(appOutDir);
    } else if (options.requireSigning && target.platform === "darwin") {
      await verifyMacPublicDistribution(appOutDir);
    }

    if (options.publicRelease) {
      await runNode("Create public application source archive", "scripts/create-source-release.cjs");
      if (!options.requireSigning) {
        await stageUnsignedReleaseNotice(target);
      }
    }

    await stageFfmpegCorrespondingSource(options, target);
    await runNode("Write release checksums", "scripts/write-release-checksums.cjs", [RELEASE_DIR]);
    completed = true;
  } finally {
    if (completed) {
      await cleanupSuccessfulIsolation(options, isolation);
    } else {
      console.error(`[release] Retained failed-run isolation for diagnostics: ${isolation.root}`);
    }
  }
  console.log(`\n[release] PASS ${target.platform}-${target.arch}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n[release] FAIL: ${error.stack || error.message || error}`);
    process.exitCode = error.exitCode || 1;
  });
}

module.exports = {
  assertReleaseOutputClean,
  configureIsolatedPaths,
  parseArgs,
  stageFfmpegCorrespondingSource,
  stageUnsignedReleaseNotice,
  unsignedPackagingEnvironment,
};
