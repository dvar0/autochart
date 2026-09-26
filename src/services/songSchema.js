/** @typedef {'imported-chart' | 'generated'} SongSource */
/** @typedef {'charted' | 'draft' | 'generating'} SongStatus */

export const SCHEMA_VERSION = 2;
export const DEFAULT_DEMUCS_ID = "demucs_default";

export function newSongId() {
  return "song_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function newVersionId(prefix = "ver") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeVersion(raw, fallback = {}) {
  const settings = raw?.settings || fallback.settings || {};
  const rawMeta = { ...(fallback.meta || {}), ...(raw?.meta || {}) };
  const chartText = raw?.chart?.text ?? raw?.chartText ?? fallback.chartText ?? "";
  const normalizedSettings = {
    difficulty: settings.difficulty || fallback.settings?.difficulty || "expert",
    model: settings.model || fallback.settings?.model || "",
  };
  const generation = settings.generation || fallback.settings?.generation;
  if (generation) normalizedSettings.generation = generation;
  const version = {
    id: raw?.id || fallback.id || newVersionId("ver"),
    name: raw?.name || fallback.name || "Chart Version",
    source: raw?.source || fallback.source || "generated",
    status: raw?.status || fallback.status || "charted",
    parentId: raw?.parentId ?? fallback.parentId ?? null,
    createdAt: raw?.createdAt ?? fallback.createdAt ?? Date.now(),
    updatedAt: raw?.updatedAt ?? fallback.updatedAt ?? raw?.createdAt ?? Date.now(),
    settings: normalizedSettings,
    meta: {
      ...rawMeta,
      noteCount: rawMeta.noteCount ?? 0,
      durationSec: rawMeta.durationSec ?? 0,
    },
    chart: { text: chartText },
  };
  if (raw?.provenance || fallback.provenance) {
    version.provenance = raw?.provenance || fallback.provenance;
  }
  if (raw?.metrics || fallback.metrics) {
    version.metrics = raw?.metrics || fallback.metrics;
  }
  return version;
}

function normalizeSourceArtifacts(raw = {}) {
  const demucs = raw?.demucs || {};
  const items = Array.isArray(demucs.items)
    ? demucs.items
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: item.id || DEFAULT_DEMUCS_ID,
          engineId: item.engineId || item.id || DEFAULT_DEMUCS_ID,
          name: item.name || (item.id === DEFAULT_DEMUCS_ID ? "Default separation" : "Demucs separation"),
          status: item.status || "ready",
          createdAt: item.createdAt ?? Date.now(),
          updatedAt: item.updatedAt ?? item.createdAt ?? Date.now(),
          profile: item.profile || "Standard Demucs",
          audioSha256: item.audioSha256 || null,
          stems: item.stems || {},
          cache: item.cache || {},
          sourceTransform: item.sourceTransform || null,
          sourceVariantKey: item.sourceVariantKey || item.sourceTransform?.key || "lead-in:0",
          provenance: item.provenance || null,
          metrics: item.metrics || null,
        }))
    : [];
  const activeId = demucs.activeId || raw?.activeDemucsId || DEFAULT_DEMUCS_ID;
  return {
    ...raw,
    demucs: {
      activeId,
      activeBySourceVariant: demucs.activeBySourceVariant || {},
      items,
    },
  };
}

function importedVersionFromRecord(record) {
  const settings = record.settings || {};
  const meta = record.meta || {};
  return normalizeVersion(null, {
    id: "imported",
    name: "Imported Clone Hero",
    source: "imported-chart",
    status: record.status || "charted",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    settings: {
      difficulty: settings.difficulty || meta.difficulty || "expert",
      model: "",
      ...(settings.generation ? { generation: settings.generation } : {}),
    },
    meta: {
      noteCount: meta.noteCount ?? 0,
      durationSec: meta.durationSec ?? 0,
      chartProvenance: meta.chartProvenance || null,
    },
    chartText: record.chart?.text || record.chartText || "",
  });
}

export function normalizeVersions(record) {
  const rawVersions = Array.isArray(record?.versions) ? record.versions : [];
  const versions = rawVersions
    .map((v) => normalizeVersion(v, { settings: record.settings, meta: record.meta }))
    .filter((v) => v.chart.text);
  const imported = importedVersionFromRecord(record);
  if (imported.chart.text && !versions.some((v) => v.id === imported.id)) {
    if (record?.source === "generated") {
      if (!versions.length) {
        versions.unshift({
          ...imported,
          id: "generated",
          name: record.settings?.model || "Generated Chart",
          source: "generated",
        });
      }
    } else {
      versions.unshift(imported);
    }
  }
  return versions.length ? versions : imported.chart.text ? [imported] : [];
}

/** @param {object} result - importSongFolder() return value */
export function createSongFromImport(result) {
  const now = Date.now();
  const m = result.meta || {};
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id: newSongId(),
    createdAt: now,
    updatedAt: now,
    source: "imported-chart",
    status: "charted",
    meta: {
      title: m.title || "Unknown",
      artist: m.artist || "Unknown",
      album: m.album || "",
      year: m.year || "",
      genre: m.genre || "",
      chartProvenance: m.chartProvenance || null,
      charter: m.charter || "",
      noteCount: m.noteCount ?? 0,
      durationSec: m.durationSec ?? 0,
      availableDifficulties: m.availableDifficulties || [],
      favorite: Boolean(m.favorite ?? m.fav),
    },
    settings: {
      difficulty: m.difficulty || "expert",
      style: "default",
      intensity: 0.5,
    },
    chart: { text: result.chartText || "" },
    arrangements: [],
    sourceArtifacts: normalizeSourceArtifacts(),
    assets: {
      audio: "audio.bin",
      albumArt: result.albumBlob ? "album.bin" : null,
      background: result.backgroundBlob
        ? {
            type: result.background?.type || "image",
            file: "background.bin",
          }
        : null,
    },
    _blobs: {
      audio: result.audioBlob,
      albumArt: result.albumBlob || null,
      background: result.backgroundBlob
        ? { type: result.background?.type || "image", blob: result.backgroundBlob }
        : null,
    },
  };
  return { ...record, versions: normalizeVersions(record) };
}

/** Normalize legacy IndexedDB rows and in-memory records. */
export function migrateRecord(raw) {
  if (!raw || typeof raw !== "object") return raw;

  const meta = raw.meta || {};
  const migrated = {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
    source: raw.source || "imported-chart",
    status: raw.status || (raw.chartText || raw.chart?.text ? "charted" : "draft"),
    meta: {
      title: meta.title || "Untitled",
      artist: meta.artist || "Unknown",
      album: meta.album || "",
      year: meta.year || "",
      genre: meta.genre || "",
      chartProvenance: meta.chartProvenance || null,
      charter: meta.charter || "Imported",
      noteCount: meta.noteCount ?? 0,
      durationSec: meta.durationSec ?? 0,
      availableDifficulties: meta.availableDifficulties || [],
      favorite: Boolean(meta.favorite ?? meta.fav ?? raw.favorite ?? raw.fav),
    },
    settings: raw.settings || {
      difficulty: meta.difficulty || "expert",
      style: "default",
      intensity: 0.5,
    },
    chart: raw.chart || { text: raw.chartText || "" },
    versions: raw.versions || [],
    arrangements: Array.isArray(raw.arrangements) ? raw.arrangements : [],
    sourceArtifacts: normalizeSourceArtifacts(raw.sourceArtifacts),
    assets: raw.assets || {
      audio: raw.audio ? "audio.bin" : null,
      albumArt: raw.albumArt ? "album.bin" : null,
      background: raw.background
        ? { type: raw.background.type || "image", file: "background.bin" }
        : null,
    },
    provenance: raw.provenance || null,
  };

  if (raw.audio || raw.albumArt || raw.background) {
    migrated._blobs = {
      audio: raw.audio ?? null,
      albumArt: raw.albumArt ?? null,
      background: raw.background ?? null,
    };
  }

  const storedBlobs = raw._blobs || raw._idbBlobs;
  if (storedBlobs) {
    migrated._blobs = {
      ...(migrated._blobs || {}),
      ...storedBlobs,
    };
  }

  migrated.versions = normalizeVersions({ ...migrated, versions: raw.versions || [] });

  return migrated;
}

/** Strip runtime blobs before persisting manifest-only payloads. */
export function stripBlobs(record) {
  const { _blobs, _legacyBlobs, audio, albumArt, background, chartText, ...rest } = record;
  return rest;
}

export function mergeSongRecord(existing, patch) {
  const base = migrateRecord(existing);
  const next = migrateRecord({
    ...base,
    ...patch,
    updatedAt: Date.now(),
  });
  if (patch.meta) next.meta = { ...base.meta, ...patch.meta };
  if (patch.settings) next.settings = { ...base.settings, ...patch.settings };
  if (patch.chart) next.chart = { ...base.chart, ...patch.chart };
  if (patch.versions) next.versions = patch.versions.map((v) => normalizeVersion(v));
  if (patch.arrangements) next.arrangements = patch.arrangements;
  if (patch.sourceArtifacts) next.sourceArtifacts = normalizeSourceArtifacts(patch.sourceArtifacts);
  if (patch.assets) next.assets = { ...base.assets, ...patch.assets };
  const priorBlobs = base._blobs || base._idbBlobs;
  if (patch._blobs || priorBlobs) {
    next._blobs = { ...(priorBlobs || {}), ...(patch._blobs || {}) };
  }
  return next;
}
