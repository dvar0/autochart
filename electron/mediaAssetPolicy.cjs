"use strict";

const path = require("path");

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const MEDIA_ASSET_ROLES = new Set([
  "audio",
  "albumArt",
  "background-image",
  "background-video",
]);

const ROLE_POLICY = {
  audio: {
    extensions: new Set([
      ".ogg", ".oga", ".opus", ".mp3", ".wav", ".wave", ".flac",
      ".m4a", ".aac", ".aiff", ".aif", ".mp4", ".m4v", ".mov",
      ".webm", ".ogv", ".mkv",
    ]),
    mimePrefixes: ["audio/", "video/"],
    // Preview uses WebAudio and therefore still decodes the complete source in
    // renderer memory. Keep this well below multi-gigabyte video allowances.
    maxSelectedBytes: 512 * MiB,
    maxInlineBytes: 32 * MiB,
  },
  albumArt: {
    extensions: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]),
    mimePrefixes: ["image/"],
    maxSelectedBytes: 32 * MiB,
    maxInlineBytes: 24 * MiB,
  },
  "background-image": {
    extensions: new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]),
    mimePrefixes: ["image/"],
    maxSelectedBytes: 64 * MiB,
    maxInlineBytes: 32 * MiB,
  },
  "background-video": {
    extensions: new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mkv"]),
    mimePrefixes: ["video/"],
    maxSelectedBytes: 16 * GiB,
    maxInlineBytes: 64 * MiB,
  },
};

function normalizeMediaAssetRole(role) {
  const value = String(role || "");
  if (!MEDIA_ASSET_ROLES.has(value)) throw new Error("Unknown library media asset role.");
  return value;
}

function backgroundAssetRole(asset = {}) {
  return asset.type === "video" ? "background-video" : "background-image";
}

function mediaAssetRole(assetKey, asset = {}) {
  if (assetKey === "audio") return "audio";
  if (assetKey === "albumArt") return "albumArt";
  if (assetKey === "background") return backgroundAssetRole(asset);
  throw new Error("Unknown library media asset.");
}

function dataByteLength(data) {
  if (data == null) return 0;
  if (typeof data.byteLength === "number") return data.byteLength;
  if (typeof data.length === "number") return data.length;
  if (data?.type === "Buffer" && Array.isArray(data.data)) return data.data.length;
  return -1;
}

function mimeMatches(policy, mime) {
  const value = String(mime || "").trim().toLowerCase();
  if (!value || value === "application/octet-stream") return false;
  return policy.mimePrefixes.some((prefix) => value.startsWith(prefix));
}

function assertMediaAssetMetadata(role, metadata = {}, { inline = false } = {}) {
  const normalizedRole = normalizeMediaAssetRole(role);
  const policy = ROLE_POLICY[normalizedRole];
  const name = path.basename(String(metadata.name || ""));
  const extension = path.extname(name).toLowerCase();
  const mime = String(metadata.mime || "").trim().toLowerCase();
  const hasSpecificMime = Boolean(mime && mime !== "application/octet-stream");
  if (
    (extension ? !policy.extensions.has(extension) : !mimeMatches(policy, mime)) ||
    (hasSpecificMime && !mimeMatches(policy, mime))
  ) {
    throw new Error(`Unsupported ${normalizedRole} file type.`);
  }

  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`Invalid ${normalizedRole} file size.`);
  }
  const limit = inline ? policy.maxInlineBytes : policy.maxSelectedBytes;
  if (size > limit) {
    const kind = inline ? "in-memory" : "selected";
    const maxMiB = Math.floor(limit / MiB);
    const playbackNote = normalizedRole === "audio" && !inline
      ? " for in-memory playback"
      : "";
    throw new Error(`${kind} ${normalizedRole} file is too large${playbackNote} (${maxMiB} MB maximum).`);
  }
  return { role: normalizedRole, name, mime, size, limit };
}

function assertInlineMediaAsset(role, asset = {}) {
  const size = dataByteLength(asset.data);
  if (size < 0) throw new Error("Invalid in-memory media payload.");
  return assertMediaAssetMetadata(
    role,
    { name: asset.name, mime: asset.mime, size },
    { inline: true }
  );
}

function mimeFromMediaFileName(fileName, fallback = "application/octet-stream") {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".flac")) return "audio/flac";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".wav") || name.endsWith(".wave")) return "audio/wav";
  if (name.endsWith(".aiff") || name.endsWith(".aif")) return "audio/aiff";
  if (name.endsWith(".opus")) return "audio/opus";
  if (name.endsWith(".ogg") || name.endsWith(".oga")) return "audio/ogg";
  if (name.endsWith(".mp4") || name.endsWith(".m4v") || name.endsWith(".mov")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".ogv")) return "video/ogg";
  if (name.endsWith(".mkv")) return "video/x-matroska";
  return fallback;
}

module.exports = {
  MEDIA_ASSET_ROLES,
  ROLE_POLICY,
  assertInlineMediaAsset,
  assertMediaAssetMetadata,
  backgroundAssetRole,
  dataByteLength,
  mediaAssetRole,
  mimeFromMediaFileName,
  normalizeMediaAssetRole,
};
