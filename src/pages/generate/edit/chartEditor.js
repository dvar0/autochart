import { chartProvenance } from "../../../../shared/chartProvenance.js";
// Editor-specific chart helpers. The existing parseChart() collapses chord
// sustains to a single max value and ignores track-local `E` events, which the
// note editor needs to round-trip. These helpers parse one difficulty track
// into a richer, editable document and write it back without disturbing the
// other sections of the .chart text.
//
// Solo sections use Clone Hero / Moonscraper track-local events: a `E solo`
// marker opens a solo and `E soloend` closes it (Moonscraper writes them
// unquoted; we tolerate quotes when reading). Star power uses `S 2 <ticks>`.

import { TRACK_BY_DIFFICULTY, parseChart } from "../../../lib/chart/parseChart.js";
import { buildTempoMap } from "../../../lib/chart/tempoMap.js";
import { newVersionId } from "../../../services/songSchema.js";

const FRET_FORCE = 5;
const FRET_TAP = 6;
const FRET_OPEN = 7;

export function sectionNameForDifficulty(difficulty = "expert") {
  return TRACK_BY_DIFFICULTY[difficulty] || TRACK_BY_DIFFICULTY.expert;
}

// Locates a `[Section] { ... }` block and reports the body line range.
function findSection(lines, sectionName) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `[${sectionName}]`) continue;
    let open = i + 1;
    while (open < lines.length && lines[open].trim() !== "{") open++;
    if (open >= lines.length) return null;
    let close = open + 1;
    while (close < lines.length && lines[close].trim() !== "}") close++;
    if (close >= lines.length) return null;
    return { header: i, open, bodyStart: open + 1, bodyEnd: close, close };
  }
  return null;
}

function bodyLinesFor(chartText, sectionName) {
  const lines = String(chartText || "").split(/\r?\n/);
  const section = findSection(lines, sectionName);
  if (!section) return [];
  return lines.slice(section.bodyStart, section.bodyEnd);
}

function detectIndent(bodyLines) {
  for (const line of bodyLines) {
    const m = line.match(/^(\s+)\S/);
    if (m) return m[1];
  }
  return "  ";
}

// Parses a `tick = TYPE rest` line into structured pieces.
function parseBodyLine(line) {
  const m = line.match(/^(\s*)(\d+)\s*=\s*(\S+)\s*(.*?)\s*$/);
  if (!m) return null;
  return { indent: m[1], tick: Number(m[2]), type: m[3], rest: m[4] || "", raw: line };
}

function soloMarkerKind(rest) {
  // `E solo` / `E "solo"` / `E soloend`. Strip the leading `E` and quotes.
  const value = String(rest || "")
    .replace(/^E\s*/i, "")
    .replace(/^"(.*)"$/, "$1")
    .trim()
    .toLowerCase();
  if (value === "solo") return "start";
  if (value === "soloend" || value === "solo_end") return "end";
  return null;
}

function makeNoteId(tick) {
  return `note_${tick}_${Math.random().toString(36).slice(2, 7)}`;
}

function makeRangeId(kind) {
  return `${kind === "solo" ? "solo" : "sp"}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Parse one difficulty track into an editable document. Notes are grouped by
 * tick with per-lane sustain preserved. Returns null pieces that the caller
 * blends with the canonical chart text.
 */
export function parseEditableChart(chartText, difficulty = "expert") {
  const text = String(chartText || "");
  const chart = parseChart(text);
  const resolution = chart.song.resolution || 192;
  const tempoMap = buildTempoMap(chart.sync, resolution);

  let chosen = difficulty;
  if (!chart.tracks[chosen]) {
    const order = ["expert", "hard", "medium", "easy"];
    chosen = order.find((d) => chart.tracks[d]) || Object.keys(chart.tracks)[0] || difficulty;
  }

  const sectionName = sectionNameForDifficulty(chosen);
  const body = bodyLinesFor(text, sectionName);

  // tick -> editable note
  const byTick = new Map();
  const ensure = (tick) => {
    let note = byTick.get(tick);
    if (!note) {
      note = { id: makeNoteId(tick), tick, lanes: [], open: false, tap: false, force: false, sustainsByLane: {} };
      byTick.set(tick, note);
    }
    return note;
  };

  const starPower = [];
  const soloMarkers = [];

  for (const line of body) {
    const parsed = parseBodyLine(line);
    if (!parsed) continue;
    const { tick, type, rest } = parsed;
    if (type === "N") {
      const parts = rest.split(/\s+/);
      const fret = Number(parts[0]);
      const sustain = Number(parts[1]) || 0;
      const note = ensure(tick);
      if (fret === FRET_FORCE) note.force = true;
      else if (fret === FRET_TAP) note.tap = true;
      else if (fret === FRET_OPEN) {
        note.open = true;
        note.sustainsByLane.open = sustain;
      } else if (fret >= 0 && fret <= 4) {
        if (!note.lanes.includes(fret)) note.lanes.push(fret);
        note.sustainsByLane[fret] = sustain;
      }
    } else if (type === "S") {
      const parts = rest.split(/\s+/);
      if (Number(parts[0]) === 2) {
        starPower.push({
          id: makeRangeId("starPower"),
          kind: "starPower",
          startTick: tick,
          endTick: tick + (Number(parts[1]) || 0),
        });
      }
    } else if (type === "E") {
      const kind = soloMarkerKind(`E ${rest}`);
      if (kind) soloMarkers.push({ tick, kind });
    }
  }

  // Pair solo start/end markers into ranges.
  const solos = [];
  soloMarkers.sort((a, b) => a.tick - b.tick || (a.kind === "start" ? -1 : 1));
  let openStart = null;
  for (const marker of soloMarkers) {
    if (marker.kind === "start") {
      if (openStart != null) solos.push({ id: makeRangeId("solo"), kind: "solo", startTick: openStart, endTick: marker.tick });
      openStart = marker.tick;
    } else if (marker.kind === "end" && openStart != null) {
      solos.push({ id: makeRangeId("solo"), kind: "solo", startTick: openStart, endTick: marker.tick });
      openStart = null;
    }
  }

  const notes = [...byTick.values()]
    .map((note) => ({ ...note, lanes: [...note.lanes].sort((a, b) => a - b) }))
    .sort((a, b) => a.tick - b.tick);

  const lastNote = notes[notes.length - 1];
  const lastTick = lastNote
    ? lastNote.tick + Math.max(0, ...Object.values(lastNote.sustainsByLane), 0)
    : 0;
  const durationSec = tempoMap.tickToSeconds(Math.max(lastTick, 0));

  return {
    difficulty: chosen,
    resolution,
    sectionName,
    chartText: text,
    song: chart.song,
    sync: chart.sync,
    events: chart.events,
    tempoMap,
    notes,
    ranges: [...starPower, ...solos],
    durationSec,
  };
}

// Deep-clones an editor doc's mutable pieces (notes/ranges). The parsed
// song/sync/events/tempoMap are treated as immutable and shared by reference.
export function cloneEditorDoc(doc) {
  if (!doc) return doc;
  return {
    ...doc,
    notes: doc.notes.map((note) => ({ ...note, lanes: [...note.lanes], sustainsByLane: { ...note.sustainsByLane } })),
    ranges: doc.ranges.map((range) => ({ ...range })),
  };
}

// Snaps a tick to the grid. snap "1/16" etc; "off" returns the tick unchanged.
export function snapTicks(resolution, snap) {
  if (!snap || snap === "off") return 0;
  const denominator = Number(String(snap).split("/")[1]) || 0;
  if (!denominator) return 0;
  return Math.max(1, Math.round((resolution * 4) / denominator));
}

export function quantizeTick(tick, resolution, snap) {
  const step = snapTicks(resolution, snap);
  if (!step) return Math.max(0, Math.round(tick));
  return Math.max(0, Math.round(tick / step) * step);
}

// Builds a fresh playback track (parseChart note shape) from the editor doc.
// Notes are cloned each call because HighwayPreview annotates them in place.
export function buildEditorPreviewTrack(doc) {
  if (!doc) return null;
  const notes = doc.notes.map((note) => {
    const sustains = Object.values(note.sustainsByLane);
    const sustain = sustains.length ? Math.max(0, ...sustains) : 0;
    return {
      tick: note.tick,
      frets: note.open ? [] : [...note.lanes].sort((a, b) => a - b),
      open: note.open,
      sustain,
      force: note.force,
      tap: note.tap,
    };
  });
  notes.sort((a, b) => a.tick - b.tick);

  const starPower = doc.ranges
    .filter((range) => range.kind === "starPower")
    .map((range) => ({ tick: range.startTick, kind: 2, length: Math.max(0, range.endTick - range.startTick) }))
    .sort((a, b) => a.tick - b.tick);

  const tempoMap = doc.tempoMap;
  const resolved = notes.map((note) => {
    const time = tempoMap.tickToSeconds(note.tick);
    const endTime = note.sustain > 0 ? tempoMap.tickToSeconds(note.tick + note.sustain) : time;
    return { ...note, time, endTime };
  });

  return {
    song: doc.song,
    tempoMap,
    notes: resolved,
    starPower,
    events: doc.events,
    solos: doc.ranges
      .filter((range) => range.kind === "solo")
      .map((range) => ({
        ...range,
        start: tempoMap.tickToSeconds(range.startTick),
        end: tempoMap.tickToSeconds(range.endTick),
      })),
  };
}

// Renders the editable note lines for one tick, in stable order.
function noteLinesForTick(note, indent) {
  const lines = [];
  if (note.open) {
    lines.push(`${indent}${note.tick} = N ${FRET_OPEN} ${Math.max(0, note.sustainsByLane.open || 0)}`);
  } else {
    for (const lane of [...note.lanes].sort((a, b) => a - b)) {
      lines.push(`${indent}${note.tick} = N ${lane} ${Math.max(0, note.sustainsByLane[lane] || 0)}`);
    }
  }
  if (note.force) lines.push(`${indent}${note.tick} = N ${FRET_FORCE} 0`);
  if (note.tap) lines.push(`${indent}${note.tick} = N ${FRET_TAP} 0`);
  return lines;
}

/**
 * Rewrites only the difficulty track section of chartText from the editor doc.
 * Managed lines (N notes, `S 2` star power, `E solo`/`E soloend`) are
 * regenerated; any other body line (non-SP `S`, other `E` events) is preserved
 * at its original tick. Output is sorted by tick with a stable per-tick order.
 */
export function writeEditableChart(chartText, difficulty, doc) {
  const text = String(chartText || "");
  const sectionName = sectionNameForDifficulty(difficulty || doc.difficulty);
  const indent = detectIndent(bodyLinesFor(text, sectionName));

  // Preserve unmanaged body lines (keep them attached to their tick).
  const preserved = [];
  for (const line of bodyLinesFor(text, sectionName)) {
    const parsed = parseBodyLine(line);
    if (!parsed) continue;
    if (parsed.type === "N") continue;
    if (parsed.type === "S" && Number(parsed.rest.split(/\s+/)[0]) === 2) continue;
    if (parsed.type === "E" && soloMarkerKind(`E ${parsed.rest}`)) continue;
    preserved.push({ tick: parsed.tick, order: 3, text: `${indent}${parsed.tick} = ${parsed.type} ${parsed.rest}`.replace(/\s+$/, "") });
  }

  const entries = [...preserved];

  // Notes (order 0). Avoid duplicate-lane / clashing data is handled upstream.
  for (const note of doc.notes) {
    if (!note.open && note.lanes.length === 0) continue;
    for (const text of noteLinesForTick(note, indent)) {
      entries.push({ tick: note.tick, order: 0, text });
    }
  }

  // Star power (order 1) and solo markers (order 2).
  for (const range of doc.ranges) {
    if (range.endTick <= range.startTick) continue;
    if (range.kind === "starPower") {
      entries.push({ tick: range.startTick, order: 1, text: `${indent}${range.startTick} = S 2 ${range.endTick - range.startTick}` });
    } else if (range.kind === "solo") {
      entries.push({ tick: range.startTick, order: 2, text: `${indent}${range.startTick} = E solo` });
      entries.push({ tick: range.endTick, order: 2, text: `${indent}${range.endTick} = E soloend` });
    }
  }

  entries.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const bodyOut = entries.map((entry) => entry.text);

  const lines = text.split(/\r?\n/);
  const section = findSection(lines, sectionName);
  if (section) {
    const before = lines.slice(0, section.bodyStart);
    const after = lines.slice(section.bodyEnd);
    return [...before, ...bodyOut, ...after].join("\n");
  }
  const trimmed = text.replace(/\s*$/, "");
  return `${trimmed}\n[${sectionName}]\n{\n${bodyOut.join("\n")}\n}\n`;
}

function playableNoteCount(doc) {
  return doc.notes.filter((note) => note.open || note.lanes.length > 0).length;
}

// Suggests the next draft name for editing a source take, e.g.
// "Fretformer Edit 1". Existing draft names increment their counter.
export function nextEditName(sourceVersion, existingNames = []) {
  const base = String(sourceVersion?.name || "Take").replace(/\s+Edit\s+\d+$/i, "").trim();
  let n = 1;
  const taken = new Set(existingNames);
  while (taken.has(`${base} Edit ${n}`)) n += 1;
  return `${base} Edit ${n}`;
}

// Builds a non-destructive edited draft version from a source version and the
// edited chart text, preserving timing/provenance metadata.
export function makeEditedVersion(sourceVersion, chartText, name, doc = null, versions = []) {
  const now = Date.now();
  const noteCount = doc ? playableNoteCount(doc) : sourceVersion?.meta?.noteCount || 0;
  return {
    id: newVersionId("edit"),
    name: name || nextEditName(sourceVersion),
    source: "generated",
    status: "draft",
    parentId: sourceVersion?.id || "imported",
    createdAt: now,
    updatedAt: now,
    settings: {
      ...(sourceVersion?.settings || {}),
      model: "Edited",
    },
    meta: {
      ...(sourceVersion?.meta || {}),
      noteCount,
      durationSec: sourceVersion?.meta?.durationSec || doc?.durationSec || 0,
      edited: true,
      chartProvenance: chartProvenance(sourceVersion, versions),
      editedFromId: sourceVersion?.id || null,
      editCount: (Number(sourceVersion?.meta?.editCount) || 0) + 1,
      // Preserve timing / source-audio identity so the draft stays compatible
      // with its siblings for final-chart assembly.
      sourceVariantKey: sourceVersion?.meta?.sourceVariantKey,
      sourceVariantLabel: sourceVersion?.meta?.sourceVariantLabel,
      leadInSilenceMs: sourceVersion?.meta?.leadInSilenceMs,
      analysisAudioSha256: sourceVersion?.meta?.analysisAudioSha256,
      analysisAudioPath: sourceVersion?.meta?.analysisAudioPath,
      timingDetector: sourceVersion?.meta?.timingDetector,
      timingRaw: sourceVersion?.meta?.timingRaw,
      timingSmoothing: sourceVersion?.meta?.timingSmoothing,
    },
    provenance: {
      ...(sourceVersion?.provenance || {}),
      editedFromId: sourceVersion?.id || null,
      editCreatedAt: now,
    },
    chart: { text: chartText },
  };
}

// Updates an existing edited draft in place (keeps id/createdAt/edit lineage).
export function updateEditedVersion(draftVersion, chartText, doc = null) {
  return {
    ...draftVersion,
    updatedAt: Date.now(),
    meta: {
      ...(draftVersion.meta || {}),
      noteCount: doc ? playableNoteCount(doc) : draftVersion.meta?.noteCount || 0,
      edited: true,
    },
    chart: { text: chartText },
  };
}
