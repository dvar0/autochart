// The project file every Clone Hero / YARG export carries (autochart.json),
// beside the separation's mel tables (autochart-tables-<stem set>.bin), so
// opening the exported folder brings the whole project back: every take, edit
// and final pick, without separating the song again. Shared by the desktop
// export (CommonJS dynamic import), the browser export and the folder import.
// Kept dependency-free.

import { delayChart } from "./chartDelay.js";

export { delayChart };
export const PROJECT_FILE = "autochart.json";
const FORMAT = "autochart-project";
const VERSION = 1;
const TABLES_PREFIX = "autochart-tables-";
const TABLES_SUFFIX = ".bin";
const STEM_SET_RE = /^[a-z0-9_]{1,48}$/i;
const DEFAULT_DEMUCS_ID = "demucs_default";

export function tablesFileName(stemSet) {
  if (!STEM_SET_RE.test(String(stemSet || ""))) throw new Error(`Invalid stem set: ${stemSet}`);
  return `${TABLES_PREFIX}${stemSet}${TABLES_SUFFIX}`;
}

// The stem set a tables file holds, or null for any other name.
export function stemSetOfTablesFile(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower.startsWith(TABLES_PREFIX) || !lower.endsWith(TABLES_SUFFIX)) return null;
  const stemSet = lower.slice(TABLES_PREFIX.length, -TABLES_SUFFIX.length);
  return STEM_SET_RE.test(stemSet) ? stemSet : null;
}

// Every file name an export may write for the project (lowercase).
export function isProjectFileName(name) {
  const lower = String(name || "").toLowerCase();
  return lower === PROJECT_FILE || Boolean(stemSetOfTablesFile(lower));
}

export async function sha256Text(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Strings that point into this machine: file paths, browser storage keys.
const LOCAL_REF_RE = /^(?:\/|[a-z]:[\\/]|\\\\|file:|opfs:|opfs-audio:|run-audio:|blob:)/i;

// A copy without anything tied to this machine or browser.
function portable(value) {
  if (Array.isArray(value)) return value.map(portable).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "cache" || key === "identity") continue;
      const next = portable(item);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  if (typeof value === "string" && LOCAL_REF_RE.test(value)) return undefined;
  return value;
}

function leadInMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

// The lead-in silence a take was charted with, in ms.
export function versionLeadInMs(version = null) {
  const generation = version?.settings?.generation || {};
  for (const value of [
    version?.meta?.leadInSilenceMs,
    version?.provenance?.sourceTransform?.leadInSilenceMs,
    generation.sourceTransform?.leadInSilenceMs,
  ]) {
    if (leadInMs(value)) return leadInMs(value);
  }
  const key = version?.provenance?.sourceTransform?.key || generation.sourceTransform?.key || "";
  return leadInMs(String(key).match(/^lead-in:(\d+)$/)?.[1]);
}

// The lead-in silence an export's audio holds: the longest any take of the
// project was charted with, so every take fits it (restoreProject moves the
// others later by the difference). The exported take moves by
// audioLeadInMs - versionLeadInMs(version).
export function audioLeadInMs(record, version = null) {
  const versions = Array.isArray(record?.versions) ? record.versions.filter(Boolean) : [];
  return Math.max(versionLeadInMs(version), ...versions.map((v) => versionLeadInMs(v)));
}

// The separation a take was charted from: its record item, else the
// project's active one for the take's lead-in. leadIn picks the separation of
// another lead-in's audio instead (the take's own pick only counts on its own).
export function separationForVersion(record, version, leadIn = versionLeadInMs(version)) {
  const demucs = record?.sourceArtifacts?.demucs || {};
  const items = Array.isArray(demucs.items) ? demucs.items.filter(Boolean) : [];
  const variant = `lead-in:${leadInMs(leadIn)}`;
  const ofVariant = items.filter((item) => (item.sourceVariantKey || item.sourceTransform?.key || "lead-in:0") === variant);
  const usedId = leadInMs(leadIn) === versionLeadInMs(version)
    ? version?.provenance?.sourceSeparation?.id || version?.provenance?.demucsSeparation?.id || ""
    : "";
  const activeId = demucs.activeBySourceVariant?.[variant] || (variant === "lead-in:0" ? demucs.activeId : "");
  return (
    ofVariant.find((item) => usedId && item.id === usedId) ||
    ofVariant.find((item) => activeId && item.id === activeId) ||
    ofVariant.find((item) => (item.engineId || item.id) === DEFAULT_DEMUCS_ID) ||
    null
  );
}

// The stored mel tables of the separation of an export's audio (the
// project's, see audioLeadInMs): [{ stemSet, path }], where path is the
// host's own reference (a cache file, or an opfs: key).
export function exportableTables(record, version) {
  const item = separationForVersion(record, version, audioLeadInMs(record, version));
  const sets = item?.stemSets && typeof item.stemSets === "object" ? item.stemSets : {};
  return Object.entries(sets)
    .filter(([stemSet, set]) => STEM_SET_RE.test(stemSet) && set?.melTables?.path)
    .map(([stemSet, set]) => ({ stemSet, path: String(set.melTables.path) }));
}

// autochart.json for an export of `version` with this notes.chart text.
// stemSets: the tables files written beside it.
export async function buildProjectFile(record, { version = null, chartText, stemSets = [] }) {
  const project = portable({
    source: record.source,
    status: record.status,
    createdAt: record.createdAt,
    meta: record.meta,
    settings: record.settings,
    chart: record.chart || null,
    versions: record.versions || [],
    arrangements: record.arrangements || [],
    provenance: record.provenance || null,
  });
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    exportedVersionId: version?.id || null,
    chartSha256: await sha256Text(chartText),
    // The exported audio's lead-in, which every take fits.
    leadInSilenceMs: audioLeadInMs(record, version),
    tables: Object.fromEntries(stemSets.map((stemSet) => [stemSet, tablesFileName(stemSet)])),
    project,
  }, null, 1);
}

export function parseProjectFile(text) {
  let file;
  try {
    file = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (file?.format !== FORMAT || file.version !== VERSION || !file.project || typeof file.project !== "object") return null;
  return file;
}

const ORIGINAL_TRANSFORM = Object.freeze({
  kind: "original",
  leadInSilenceSeconds: 0,
  leadInSilenceMs: 0,
  key: "lead-in:0",
  label: "No lead-in",
});

// A take on the exported audio: its lead-in is in the song now, and a take
// charted with less moves later by the rest (chart, Inpaint history, length).
function onExportedAudio(version, delayMs) {
  const delayed = delayChart(version.chart?.text, delayMs);
  const durationSec = Number(version.meta?.durationSec) || 0;
  const next = {
    ...version,
    meta: {
      ...(version.meta || {}),
      leadInSilenceMs: 0,
      sourceVariantKey: ORIGINAL_TRANSFORM.key,
      sourceVariantLabel: ORIGINAL_TRANSFORM.label,
      ...(delayed.ticks && durationSec ? { durationSec: durationSec + delayMs / 1000 } : {}),
    },
    ...(delayed.ticks ? { chart: { ...version.chart, text: delayed.chartText } } : {}),
    ...(delayed.ticks && version.editHistory ? { editHistory: delayEditHistory(version.editHistory, delayed.ticks) } : {}),
  };
  if (!versionLeadInMs(version)) return next;
  if (version.provenance) {
    next.provenance = { ...version.provenance, sourceTransform: ORIGINAL_TRANSFORM };
  }
  const generation = version.settings?.generation;
  if (generation) {
    next.settings = {
      ...version.settings,
      generation: {
        ...generation,
        sourceTransform: ORIGINAL_TRANSFORM,
        ...(generation.controls ? { controls: { ...generation.controls, leadInSilenceSeconds: "0" } } : {}),
        ...(generation.resolved ? { resolved: { ...generation.resolved, leadInSilenceSeconds: 0 } } : {}),
      },
    };
  }
  return next;
}

// An edited draft's Inpaint history (chartEditor.js editHistoryFromDoc), its
// ticks moved later: areas, "tick,fret,sustain" notes, hand-edited ticks.
function delayEditHistory(history, ticks) {
  const at = (tick) => (Number.isFinite(tick) ? tick + ticks : tick);
  const notes = (text) => String(text || "").split(" ").filter(Boolean).map((item) => {
    const [tick, ...rest] = item.split(",");
    return [at(Number(tick)), ...rest].join(",");
  }).join(" ");
  return {
    ...history,
    ...(Array.isArray(history.redos) ? {
      redos: history.redos.map((redo) => ({
        ...redo,
        ...(redo?.region ? { region: { ...redo.region, startTick: at(redo.region.startTick), endTick: at(redo.region.endTick) } } : {}),
        ...(typeof redo?.original === "string" ? { original: notes(redo.original) } : {}),
        ...(Array.isArray(redo?.takes) ? { takes: redo.takes.map(notes) } : {}),
      })),
    } : {}),
    ...(Array.isArray(history.touched) ? { touched: history.touched.map(at) } : {}),
  };
}

// The project an exported folder carries, for its notes.chart text. Every
// take comes back on the exported audio, moved later by any lead-in it lacks;
// only takes charted with more lead-in than the audio holds (from exports
// made before every take fit the audio) stay out. A notes.chart changed since
// the export comes back as a new take.
// Returns { project, activeVersionId, editedChart, dropped }.
export async function restoreProject(file, chartText) {
  const exportedLeadIn = leadInMs(file.leadInSilenceMs);
  const all = Array.isArray(file.project.versions) ? file.project.versions.filter((v) => v && v.id) : [];
  const kept = all.filter((version) => versionLeadInMs(version) <= exportedLeadIn);
  const versions = kept.map((version) => onExportedAudio(version, exportedLeadIn - versionLeadInMs(version)));
  const editedChart = (await sha256Text(chartText)) !== file.chartSha256;
  const exportedId = versions.some((v) => v.id === file.exportedVersionId) ? file.exportedVersionId : null;
  // The project's own chart: the one it was imported with (no lead-in), or a
  // generated project's first take.
  const chart = file.project.chart;
  const twin = chart?.text ? all.find((version) => version.chart?.text === chart.text) : null;
  const chartDelay = exportedLeadIn - (twin ? versionLeadInMs(twin) : 0);
  return {
    project: {
      ...file.project,
      chart: chart?.text && chartDelay > 0 ? { ...chart, text: delayChart(chart.text, chartDelay).chartText } : chart,
      versions,
    },
    activeVersionId: exportedId,
    editedChart,
    dropped: all.length - kept.length,
  };
}

// A separation item for tables seeded under the restored song audio.
export function restoredSeparation({ audioSha256, stemSets, now = Date.now() }) {
  return {
    activeId: DEFAULT_DEMUCS_ID,
    activeBySourceVariant: { "lead-in:0": DEFAULT_DEMUCS_ID },
    items: [{
      id: DEFAULT_DEMUCS_ID,
      engineId: DEFAULT_DEMUCS_ID,
      name: "Default separation",
      status: "ready",
      createdAt: now,
      updatedAt: now,
      profile: "Standard Demucs",
      audioSha256,
      stems: stemSets?.htdemucs?.stems || {},
      stemSets: stemSets || {},
      cache: {},
      sourceTransform: ORIGINAL_TRANSFORM,
      sourceVariantKey: "lead-in:0",
      provenance: null,
      metrics: null,
    }],
  };
}

// Reads the header of a tables file (gzip) to check it before storing it:
// { recipe, channels } or null when it isn't one.
export async function tablesFileHeader(bytes) {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const headerLength = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
    if (headerLength <= 0 || 4 + headerLength > data.length) return null;
    const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)));
    if (header?.format !== "autochart-mel-tables" || !Array.isArray(header.channels) || !Array.isArray(header.shapes)) return null;
    const values = header.shapes.reduce((sum, [mels, frames]) => sum + Number(mels) * Number(frames), 0);
    const expected = 4 + headerLength + (headerLength % 2) + values * 2;
    return data.length === expected ? { recipe: header.recipe, channels: header.channels } : null;
  } catch {
    return null;
  }
}
