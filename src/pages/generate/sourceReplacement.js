import {
  DEFAULT_GENERATION_CONTROLS,
} from "../../data/generationSettings.js";
import { DEFAULT_DEMUCS_ID, newSongId } from "../../services/songSchema.js";

export function beginMediaRequest(requestRef) {
  const id = Number(requestRef.current || 0) + 1;
  requestRef.current = id;
  return {
    id,
    isCurrent: () => requestRef.current === id,
  };
}

export function beginExclusiveMediaTransaction(transactionRef) {
  if (transactionRef.current) return null;
  transactionRef.current = true;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      transactionRef.current = false;
    },
  };
}

export function emptyReplacementSourceArtifacts() {
  return { demucs: { activeId: DEFAULT_DEMUCS_ID, activeBySourceVariant: {}, items: [] } };
}

export function buildSourceReplacementRecord({ file, mediaInfo = {}, backgroundType = null } = {}) {
  if (!file) throw new Error("A source media file is required.");
  const now = Date.now();
  const meta = mediaInfo.meta || {};
  const fallbackTitle = String(file.name || "Untitled")
    .replace(/\.[^/.]+$/, "")
    .replace(/[_.-]+/g, " ")
    .trim() || "Untitled";
  const title = String(meta.title || "").trim() || fallbackTitle;
  const albumArt = mediaInfo.albumBlob || null;
  const background = backgroundType
    ? { type: backgroundType, blob: file }
    : null;
  return {
    schemaVersion: 2,
    id: newSongId(),
    createdAt: now,
    updatedAt: now,
    source: "generated",
    status: "draft",
    meta: {
      title,
      artist: meta.artist || "Unknown Artist",
      album: meta.album || "",
      year: meta.year || "",
      genre: meta.genre || "",
      charter: "Autochart",
      noteCount: 0,
      durationSec: 0,
      availableDifficulties: [],
    },
    settings: {
      ...DEFAULT_GENERATION_CONTROLS,
      difficulty: DEFAULT_GENERATION_CONTROLS.difficulty || "expert",
      activeVersionId: null,
    },
    chart: { text: "" },
    versions: [],
    arrangements: [],
    sourceArtifacts: emptyReplacementSourceArtifacts(),
    assets: {
      audio: file.name || "audio.bin",
      albumArt: albumArt ? albumArt.name || "album.bin" : null,
      background: background
        ? { type: background.type, file: file.name || (background.type === "video" ? "background.mp4" : "background.png") }
        : null,
    },
    _blobs: {
      audio: file,
      albumArt,
      background,
    },
  };
}
