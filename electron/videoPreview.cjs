"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { resolveFfmpegPath } = require("./ffmpegPath.cjs");
const { lstatRegular, sameIdentity } = require("./fileSafety.cjs");
const { MEDIA_SCHEME } = require("./mediaProtocol.cjs");

// Originals remain the generation/export sources. Only undecodable renderer
// backgrounds need this disposable, silent VP8 proxy (with autorotation).
const VARIANT = "vp8-fit854-1200k-v1";
const pending = new Map();
const sources = new Map();

function transcode(source, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), [
      "-nostdin", "-v", "error", "-n", "-i", source,
      "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", "scale=w='min(854,iw)':h='min(854,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8",
      "-threads", "4", "-b:v", "1200k", "-pix_fmt", "yuv420p", destination,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(true);
      // Containers such as WebM and MP4 can contain only audio. Chromium's
      // missing decoded frame alone cannot distinguish that from a codec issue.
      if (/Stream map ['"](?:0:v:0)?['"] matches no streams\./.test(stderr)) return resolve(false);
      reject(new Error(`Could not prepare a compatible video preview. ${stderr.trim()}`));
    });
  });
}

async function prepareVideoPreview(source, cacheFolder) {
  const original = await lstatRegular(source.path, "Video source");
  if (!sameIdentity(source, original.identity)) throw new Error("Video source changed before conversion.");
  const key = crypto.createHash("sha256").update(JSON.stringify([
    VARIANT, source.path, original.identity,
  ])).digest("hex");
  const directory = path.join(cacheFolder, "video-previews");
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Video cache must not be a symbolic link.");
  const destination = path.join(directory, `${key}.webm`);
  if (!pending.has(destination)) {
    const work = (async () => {
      try {
        const cached = await lstatRegular(destination, "Video preview");
        if (cached.stat.size > 0) return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const temporary = path.join(directory, `${key}-${crypto.randomUUID()}.webm`);
      try {
        const hasVideo = await transcode(source.path, temporary);
        const current = await lstatRegular(source.path, "Video source");
        if (!sameIdentity(original.identity, current.identity)) throw new Error("Video source changed during conversion.");
        if (!hasVideo) return false;
        const output = await lstatRegular(temporary, "Video preview");
        if (!output.stat.size) throw new Error("Video conversion produced an empty preview.");
        await fs.rename(temporary, destination);
        return true;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    })();
    pending.set(destination, work);
    work.finally(() => pending.delete(destination)).catch(() => {});
  }
  if (!await pending.get(destination)) return null;
  const output = await lstatRegular(destination, "Video preview");
  const token = crypto.createHash("sha256").update(destination).digest("hex");
  sources.set(token, { path: destination, name: `${key}.webm`, mime: "video/webm", ...output.identity });
  return `${MEDIA_SCHEME}://preview/${token}`;
}

function getVideoPreviewSource(token) {
  const source = sources.get(token);
  if (!source) throw new Error("Unknown video preview.");
  return source;
}

module.exports = { prepareVideoPreview, getVideoPreviewSource };
