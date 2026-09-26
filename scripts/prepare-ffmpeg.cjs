"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const tar = require("tar");
const inputs = require("./ffmpeg-sources.json");
const root = path.resolve(__dirname, "..");
const recipeFiles = ["ffmpeg-sources.json", "ffmpeg-build.sh"];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fileHash(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${file}`);
  return hash(fs.readFileSync(file));
}
function recipeHash() {
  return hash(Buffer.concat(recipeFiles.map((name) => fs.readFileSync(path.join(__dirname, name)))));
}
function buildEnvironment(source = process.env, platform = process.platform, msysRoot = "") {
  // FFmpeg configure writes `set` to config.log, which we publish with sources.
  // Never pass model-host/signing credentials, BASH_ENV, or compiler overrides.
  const env = {};
  for (const name of ["TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SystemDrive"]) {
    if (source[name]) env[name] = source[name];
  }
  env.PATH = source.PATH || source.Path || "";
  // Permit an explicit installed Apple SDK when xcrun's default is incompatible
  // with the selected Command Line Tools. Do not inherit arbitrary build flags.
  if (platform === "darwin" && source.SDKROOT) {
    if (!path.isAbsolute(source.SDKROOT) || !fs.statSync(source.SDKROOT).isDirectory()) {
      throw new Error("SDKROOT must point to an installed macOS SDK directory.");
    }
    env.SDKROOT = source.SDKROOT;
  }
  if (source.AUTOCHART_BUILD_JOBS) {
    if (!/^[1-9][0-9]?$/.test(source.AUTOCHART_BUILD_JOBS)) throw new Error("AUTOCHART_BUILD_JOBS must be an integer from 1 to 99.");
    env.AUTOCHART_BUILD_JOBS = source.AUTOCHART_BUILD_JOBS;
  }
  if (platform === "win32") {
    env.MSYSTEM = "UCRT64";
    env.PATH = `${path.join(msysRoot, "ucrt64", "bin")};${path.join(msysRoot, "usr", "bin")};${env.PATH}`;
  }
  return env;
}
function buildDirectory(projectDir = root, platform = process.platform, arch = process.arch) {
  return path.join(projectDir, "node_modules", ".cache", "autochart-ffmpeg", `${platform}-${arch}`);
}
function readBuild({ projectDir = root, platform = process.platform, arch = process.arch } = {}) {
  const directory = buildDirectory(projectDir, platform, arch);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "build.json"), "utf8"));
  if (receipt.target !== `${platform}-${arch}` || receipt.recipeSha256 !== recipeHash()) {
    throw new Error("FFmpeg build is stale or belongs to another target; run npm run ffmpeg:prepare.");
  }
  const executable = path.join(directory, platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const sourceArchive = path.join(directory, "corresponding-source.tar.gz");
  if (fileHash(executable) !== receipt.executableSha256 || fileHash(sourceArchive) !== receipt.sourceSha256) {
    throw new Error("FFmpeg executable/source checksum mismatch; rebuild with npm run ffmpeg:prepare -- --rebuild.");
  }
  return { ...receipt, directory, executable, sourceArchive };
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code}).`)));
  });
}
async function download(source, destination) {
  if (fs.existsSync(destination)) {
    if (fileHash(destination) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.name}`);
    return;
  }
  let url = source.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (new URL(url).protocol !== "https:") throw new Error("FFmpeg sources require HTTPS.");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(120000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (!response.ok) throw new Error(`Download failed: ${source.name} (${response.status})`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error("FFmpeg source download exceeds 64 MiB.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== source.sha256) throw new Error(`Source checksum mismatch: ${source.name}`);
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    return;
  }
  throw new Error("Too many source download redirects.");
}
async function prepareFfmpeg({ projectDir = root, platform = process.platform, arch = process.arch, rebuild = false } = {}) {
  if (platform !== process.platform || arch !== process.arch) throw new Error("Build FFmpeg on the target OS and architecture.");
  if (!require("../config/supported-targets.cjs").supportedTarget(platform, arch)) throw new Error("Unsupported FFmpeg target.");
  const directory = buildDirectory(projectDir, platform, arch);
  if (!rebuild && fs.existsSync(path.join(directory, "build.json"))) return readBuild({ projectDir, platform, arch });
  const cache = path.dirname(directory);
  const downloads = path.join(cache, "downloads");
  fs.mkdirSync(downloads, { recursive: true });
  for (const source of inputs.sources) await download(source, path.join(downloads, source.name));
  const staging = fs.mkdtempSync(path.join(cache, "prepare-"));
  const work = path.join(staging, "work");
  const sourceDir = path.join(staging, "source");
  const output = path.join(staging, "output");
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(output);
  for (const source of inputs.sources) fs.copyFileSync(path.join(downloads, source.name), path.join(sourceDir, source.name));
  for (const name of recipeFiles) fs.copyFileSync(path.join(__dirname, name), path.join(sourceDir, name));
  const sourceRecipeHash = hash(Buffer.concat(recipeFiles.map((name) => fs.readFileSync(path.join(sourceDir, name)))));
  fs.writeFileSync(path.join(sourceDir, "README.txt"),
    `Autochart FFmpeg ${inputs.version} corresponding source\n\n` +
    "Contains unmodified upstream FFmpeg, libogg, libvorbis, libvpx and dav1d source archives, including licenses, and the exact build recipe.\n" +
    "Rebuild offline: bash ffmpeg-build.sh . /absolute/path/to/an/empty/build-directory\n" +
    "Prerequisites: C compiler, make, pkg-config, tar, xz, Meson, Ninja and NASM (x86). Linux: build-essential pkg-config xz-utils meson ninja-build nasm (Ubuntu 24.04).\n" +
    "macOS: Xcode command-line tools, pkgconf, meson and ninja. Windows: MSYS2 UCRT64 gcc, make, pkgconf, meson, ninja, nasm, tar and xz; run in UCRT64 shell.\n" +
    "No external codec downloads are needed. FFmpeg uses LGPL-2.1-or-later; libogg, libvorbis, libvpx and dav1d use BSD licenses.\n" +
    "The app executes FFmpeg separately; replace resources/ffmpeg/ffmpeg (ffmpeg.exe on Windows) with your rebuilt executable.\n" +
    "Compiler and OS versions can change binary bytes; this recipe does not promise byte-for-byte reproducibility.\n");
  console.log(`[ffmpeg] Building ${inputs.version} for ${platform}-${arch}; sources are SHA-256 pinned.`);
  const bash = platform === "win32" ? (process.env.AUTOCHART_MSYS2_BASH || "C:\\msys64\\usr\\bin\\bash.exe") : "bash";
  const msysRoot = platform === "win32" ? path.resolve(path.dirname(bash), "..", "..") : "";
  const shellPath = (value) => platform === "win32" ? value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;
  await run(bash, [shellPath(path.join(sourceDir, "ffmpeg-build.sh")), shellPath(sourceDir), shellPath(work)], {
    env: buildEnvironment(process.env, platform, msysRoot),
  });
  const executableName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const executable = path.join(output, executableName);
  fs.copyFileSync(path.join(work, "install", "bin", executableName), executable);
  fs.chmodSync(executable, 0o755);
  fs.copyFileSync(path.join(work, `ffmpeg-${inputs.version}`, "ffbuild", "config.log"), path.join(sourceDir, "config.log"));
  fs.copyFileSync(path.join(work, `ffmpeg-${inputs.version}`, "config.h"), path.join(sourceDir, "config.h"));
  if (recipeHash() !== sourceRecipeHash) throw new Error("FFmpeg recipe changed during the build; rerun preparation.");
  const receipt = { target: `${platform}-${arch}`, version: inputs.version, recipeSha256: sourceRecipeHash, executableSha256: fileHash(executable), executableSize: fs.statSync(executable).size, buildHost: `${os.type()} ${os.release()}` };
  fs.writeFileSync(path.join(sourceDir, "build-info.json"), JSON.stringify(receipt, null, 2) + "\n");
  const sourceArchive = path.join(output, "corresponding-source.tar.gz");
  await tar.c({ cwd: sourceDir, file: sourceArchive, gzip: true, portable: true }, fs.readdirSync(sourceDir).sort());
  receipt.sourceSha256 = fileHash(sourceArchive);
  fs.writeFileSync(path.join(output, "build.json"), JSON.stringify(receipt, null, 2) + "\n");
  fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(output, directory);
  fs.rmSync(staging, { recursive: true, force: true });
  return readBuild({ projectDir, platform, arch });
}
module.exports = { prepareFfmpeg, readBuild, buildDirectory, recipeHash, fileHash, buildEnvironment };
if (require.main === module) prepareFfmpeg({ rebuild: process.argv.includes("--rebuild") }).then((build) => console.log(`[ffmpeg] Ready: ${build.executable}`)).catch((error) => { console.error(error); process.exitCode = 1; });
