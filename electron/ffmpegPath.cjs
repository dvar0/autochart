const fs = require("fs");
const path = require("path");

function executableName() {
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function packageFfmpegPath() {
  return path.join(__dirname, "..", "node_modules", ".cache", "autochart-ffmpeg", `${process.platform}-${process.arch}`, executableName());
}

function resourceFfmpegPath() {
  if (!process.resourcesPath) return "";
  return path.join(process.resourcesPath, "ffmpeg", executableName());
}

function ensureExecutable(filePath) {
  if (!filePath || process.platform === "win32" || filePath === "ffmpeg") return filePath;
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // If chmod fails, let spawn report the actual execution error.
  }
  return filePath;
}

function resolveFfmpegPath() {
  const override = String(process.env.AUTOCHART_FFMPEG_PATH || "").trim();
  if (override) return override;

  const bundled = firstExisting([
    resourceFfmpegPath(),
    packageFfmpegPath(),
  ]);
  return ensureExecutable(bundled || "ffmpeg");
}

module.exports = {
  resolveFfmpegPath,
};
