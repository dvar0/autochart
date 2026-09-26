"use strict";

// .chart tempo-map reading, shared by the engine's timing stage (imported chart
// sync) and its generated-chart reporting.

// Enough for ~2.5 hours of quarter notes at 120 BPM; guards pathological tempo maps.
const SOURCE_CHART_MAX_BEATS = 20000;
const DEFAULT_RESOLUTION = 192;

function parseChartSections(text) {
  const sections = {};
  let current = null;
  let body = null;
  for (const raw of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)]$/);
    if (header) {
      current = header[1];
      body = [];
      sections[current] = body;
      continue;
    }
    if (!current || line === "{" || line === "}") continue;
    body.push(line);
  }
  return sections;
}

function chartKeyValue(line) {
  const eq = String(line || "").indexOf("=");
  if (eq === -1) return null;
  return {
    key: String(line).slice(0, eq).trim(),
    value: String(line).slice(eq + 1).trim(),
  };
}

function chartResolution(songLines) {
  for (const line of songLines || []) {
    const kv = chartKeyValue(line);
    if (kv?.key !== "Resolution") continue;
    const parsed = Math.trunc(Number(kv.value));
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
    return DEFAULT_RESOLUTION;
  }
  return DEFAULT_RESOLUTION;
}

function chartOffset(songLines) {
  const entry = (songLines || []).map(chartKeyValue).find((kv) => kv?.key === "Offset");
  const value = Number(entry?.value || 0);
  if (!Number.isFinite(value)) throw new Error("The imported notes.chart has an invalid Offset.");
  return value;
}

function chartBpms(syncLines) {
  const bpms = [];
  for (const line of syncLines || []) {
    const kv = chartKeyValue(line);
    if (!kv) continue;
    const parts = kv.value.split(/\s+/);
    if (parts[0] !== "B") continue;
    const tick = Number(kv.key);
    const bpm = Number(parts[1]) / 1000;
    if (Number.isFinite(tick) && tick >= 0 && Number.isFinite(bpm) && bpm > 0) {
      bpms.push({ tick, bpm });
    }
  }
  bpms.sort((a, b) => a.tick - b.tick);
  if (!bpms.length) bpms.push({ tick: 0, bpm: 120 });
  if (bpms[0].tick !== 0) bpms.unshift({ tick: 0, bpm: bpms[0].bpm });
  return bpms;
}

function tickToSeconds(tick, bpms, resolution) {
  let elapsed = 0;
  for (let i = 0; i < bpms.length; i += 1) {
    const current = bpms[i];
    const next = bpms[i + 1];
    const secondsPerTick = 60 / (current.bpm * resolution);
    if (!next || tick < next.tick) return elapsed + (tick - current.tick) * secondsPerTick;
    elapsed += (next.tick - current.tick) * secondsPerTick;
  }
  return 0;
}

// Time-signature events from a [SyncTrack]: "<tick> = TS <numerator> [log2(denominator)]".
function chartTimeSignatures(syncLines) {
  const signatures = [];
  for (const line of syncLines || []) {
    const kv = chartKeyValue(line);
    if (!kv) continue;
    const parts = kv.value.split(/\s+/);
    if (parts[0] !== "TS") continue;
    const tick = Number(kv.key);
    const numerator = Number(parts[1]);
    const denominatorLog2 = parts.length > 2 ? Number(parts[2]) : 2;
    if (!Number.isFinite(tick) || tick < 0 || !Number.isFinite(numerator) || numerator <= 0) continue;
    const denominator = Number.isFinite(denominatorLog2) && denominatorLog2 >= 0 && denominatorLog2 <= 6
      ? 2 ** denominatorLog2
      : 4;
    signatures.push({ tick, numerator, denominator });
  }
  signatures.sort((a, b) => a.tick - b.tick);
  if (!signatures.length || signatures[0].tick !== 0) {
    signatures.unshift({ tick: 0, numerator: 4, denominator: 4 });
  }
  return signatures;
}

// chartBpms() invents a 120 BPM anchor when a chart has none, which would turn a
// missing tempo map into silently made-up timing.
function hasChartTempoAnchor(syncLines) {
  for (const line of syncLines || []) {
    const kv = chartKeyValue(line);
    if (!kv) continue;
    const parts = kv.value.split(/\s+/);
    if (parts[0] === "B" && Number.isFinite(Number(kv.key)) && Number(kv.key) >= 0 &&
        Number.isFinite(Number(parts[1])) && Number(parts[1]) > 0) return true;
  }
  return false;
}

// Explicit resolution conversions rescale event ticks without changing tempos.
function rescaleSyncTicks(events, scale) {
  const scaled = [];
  for (const event of events) {
    const tick = Math.max(0, Math.round(event.tick * scale));
    if (scaled.length && scaled[scaled.length - 1].tick === tick) scaled[scaled.length - 1] = { ...event, tick };
    else scaled.push({ ...event, tick });
  }
  return scaled;
}

// Time signatures come first at a shared tick, matching Moonscraper's ordering.
function syncLinesFromTempoMap(bpms, signatures) {
  const events = [
    ...signatures.map((ts) => ({
      tick: ts.tick,
      order: 0,
      line: `${ts.tick} = TS ${ts.numerator}${ts.denominator === 4 ? "" : ` ${Math.round(Math.log2(ts.denominator))}`}`,
    })),
    ...bpms.map((tempo) => ({
      tick: tempo.tick,
      order: 1,
      line: `${tempo.tick} = B ${Math.round(tempo.bpm * 1000)}`,
    })),
  ];
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  return events.map((event) => event.line);
}

// Beat grid taken straight from a human-authored [SyncTrack]: one beat per
// quarter note, downbeats at measure starts, shifted to audio time by Offset.
// Native resolution and sync lines are preserved unless a conversion is requested.
function sourceChartBeatGrid(chartText, { resolution: requestedResolution, audioDuration = null } = {}) {
  const sections = parseChartSections(chartText);
  if (!hasChartTempoAnchor(sections.SyncTrack)) {
    throw new Error("The imported notes.chart has no usable [SyncTrack] tempo map.");
  }
  const sourceResolution = chartResolution(sections.Song);
  const resolution = requestedResolution ?? sourceResolution;
  if (!Number.isSafeInteger(resolution) || resolution < 1) throw new Error("Invalid chart resolution.");
  const offset = chartOffset(sections.Song);
  const scale = resolution / sourceResolution;
  const bpms = rescaleSyncTicks(chartBpms(sections.SyncTrack), scale);
  const signatures = rescaleSyncTicks(chartTimeSignatures(sections.SyncTrack), scale);

  const limit = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : null;
  const beatTimes = [];
  for (let beat = 0; beat <= SOURCE_CHART_MAX_BEATS; beat += 1) {
    const seconds = tickToSeconds(beat * resolution, bpms, resolution) + offset;
    beatTimes.push(seconds);
    // The beat past the end of the audio closes the last usable beat window.
    if (limit != null && seconds > limit) break;
  }
  if (beatTimes.length < 2 || (limit != null && beatTimes[beatTimes.length - 1] <= limit)) {
    throw new Error("The imported notes.chart tempo map does not cover the audio.");
  }

  const lastBeatTick = (beatTimes.length - 1) * resolution;
  const downbeatTimes = [];
  for (let i = 0; i < signatures.length && downbeatTimes.length < SOURCE_CHART_MAX_BEATS; i += 1) {
    const signature = signatures[i];
    const end = Math.min(signatures[i + 1] ? signatures[i + 1].tick - 1 : lastBeatTick, lastBeatTick);
    const measureTicks = Math.max(
      1,
      Math.round((signature.numerator * resolution * 4) / signature.denominator)
    );
    for (let tick = signature.tick; tick <= end && downbeatTimes.length < SOURCE_CHART_MAX_BEATS; tick += measureTicks) {
      downbeatTimes.push(tickToSeconds(tick, bpms, resolution) + offset);
    }
  }

  return {
    beatTimes,
    downbeatTimes,
    resolution,
    sourceResolution,
    offset,
    tempoMap: bpms,
    timeSignatures: signatures,
    syncLines: resolution === sourceResolution ? sections.SyncTrack : syncLinesFromTempoMap(bpms, signatures),
  };
}

module.exports = {
  SOURCE_CHART_MAX_BEATS,
  chartBpms,
  chartKeyValue,
  chartOffset,
  chartResolution,
  chartTimeSignatures,
  hasChartTempoAnchor,
  parseChartSections,
  rescaleSyncTicks,
  sourceChartBeatGrid,
  syncLinesFromTempoMap,
  tickToSeconds,
};
