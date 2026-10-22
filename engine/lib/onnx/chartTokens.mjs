// A .chart difficulty as the transcriber's token stream, so a model can read a
// chart the app already has (Regenerate's inpainting context). Ports of the
// training repo's
//   src/data/chart_event_stream.py   chart_to_stream_events, encode_events
//   src/data/chart_structure.py      read_solo_spans, read_sections (labels v2)
//   src/data/chart_descriptors.py    compute_descriptors / descriptor_bins (v2)
// Python's round() is round-half-to-even; pyRound keeps beats and grid ticks
// identical to the training data on charts whose ticks fall on a half.

import { parseChartSections, chartResolution } from "../chartTiming.mjs";
import {
  TICKS_PER_BEAT,
  SUSTAIN_BUCKET_TICKS,
  BOS_TOKEN,
  EOS_TOKEN,
  BEAT_TOKEN,
  POS_BASE,
  NOTE_BASE,
  OPEN_TOKEN,
  MOD_HOPO_TOKEN,
  MOD_TAP_TOKEN,
  SUS_BASE,
  N_DESCRIPTORS,
  DESC_AUTO_BIN,
  difficultyToken,
  descriptorToken,
} from "./chartEventStream.mjs";

const TRACK_BY_DIFFICULTY = { expert: "ExpertSingle", hard: "HardSingle", medium: "MediumSingle", easy: "EasySingle" };

function pyRound(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function quantizeSustain(gridTicks) {
  if (gridTicks < SUSTAIN_BUCKET_TICKS[0]) return 0;
  let best = SUSTAIN_BUCKET_TICKS[0];
  for (const edge of SUSTAIN_BUCKET_TICKS) {
    if (Math.abs(gridTicks - edge) <= Math.abs(gridTicks - best)) best = edge;
  }
  return best;
}

// chart_to_stream_events over one track's lines. Only ticks with a fret or
// open note are events; N 5 / N 6 at such a tick mark it HOPO / tap.
function trackEvents(lines, resolution) {
  const byTick = new Map();
  const modifiers = new Map();
  for (const line of lines) {
    const m = line.match(/^(\d+)\s*=\s*N\s+(\d+)\s+(\d+)/);
    if (!m) continue;
    const tick = Number(m[1]);
    const fret = Number(m[2]);
    const sustain = Number(m[3]);
    if (fret === 5 || fret === 6) {
      if (!modifiers.has(tick)) modifiers.set(tick, new Set());
      modifiers.get(tick).add(fret === 5 ? "hopo" : "tap");
      continue;
    }
    if (!(fret <= 4 || fret === 7)) continue;
    let entry = byTick.get(tick);
    if (!entry) {
      entry = { frets: new Set(), open: false, sustain: 0 };
      byTick.set(tick, entry);
    }
    if (fret === 7) entry.open = true;
    else entry.frets.add(fret);
    entry.sustain = Math.max(entry.sustain, sustain);
  }
  const res = Math.max(1, resolution);
  const events = [];
  const occupied = new Set();
  for (const tick of [...byTick.keys()].sort((a, b) => a - b)) {
    const entry = byTick.get(tick);
    let gridTick = pyRound((tick * TICKS_PER_BEAT) / res);
    // simultaneous-but-distinct source ticks never merge after quantization
    while (occupied.has(gridTick)) gridTick += 1;
    occupied.add(gridTick);
    let bitmap = 0;
    for (const fret of entry.frets) bitmap |= 1 << fret;
    const isOpen = entry.open && bitmap === 0;
    if (bitmap === 0 && !isOpen) continue;
    const mods = modifiers.get(tick) || new Set();
    events.push({
      beat: Math.floor(gridTick / TICKS_PER_BEAT),
      tick: gridTick % TICKS_PER_BEAT,
      bitmap,
      is_open: isOpen,
      is_hopo: mods.has("hopo"),
      is_tap: mods.has("tap"),
      sustain_ticks: quantizeSustain((entry.sustain * TICKS_PER_BEAT) / res),
    });
  }
  return events;
}

// read_solo_spans over the track itself: [startBeat, endBeat | null].
function soloSpans(lines, resolution) {
  const marks = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s*=\s*E\s+"?(soloend|solo)"?\s*$/i);
    if (m) marks.push([Number(m[1]), m[2].toLowerCase()]);
  }
  marks.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const spans = [];
  let start = null;
  for (const [tick, kind] of marks) {
    if (kind === "solo" && start === null) start = tick;
    else if (kind === "soloend" && start !== null) {
      spans.push([start, tick]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, null]);
  const res = Math.max(1, resolution);
  return spans.map(([s, e]) => {
    const startBeat = pyRound(s / res);
    return [startBeat, e === null ? null : Math.max(pyRound(e / res), startBeat + 1)];
  });
}

const SECTION_RULES = [
  ["build", /\bpre ?(chorus|solo|drop|verse)\b|\bbuild ?up\b|\bbuild\b|\brise\b/],
  ["solo", /solo/],
  ["breakdown", /breakdown/],
  ["drop", /\bdrop\b/],
  ["chorus", /chorus|refrain|\bhook\b|\bcoro\b|estribillo/],
  ["verse", /verse|\bverso\b|strophe/],
  ["bridge", /bridge|middle ?(eight|8)/],
  ["intro", /intro|opening|song start/],
  ["outro", /outro|ending|\bend\b|coda|fade|finale/],
  ["instrumental", /riff|interlude|\bbreak\b|transition|instrumental|theme|groove|\blead\b|melody|motif|\bhead\b|\bmain\b|arpeggio|tapping|\bchug|djent|\bfill\b/],
];
const EXTRA_RULES_V2 = [
  ["solo", /\bjam\b/],
  ["build", /tension|crescendo|speed ?up|\bclimb/],
  ["breakdown", /\bmosh|heavy part|\bthall/],
  ["outro", /end ?of ?song/],
  ["instrumental", /\bchords?\b|\blick\b|gtr line|\barps?\b|sweeps|\bbells\b|(guitar|bass|drums|band) enters/],
];

function normalizeSectionName(name, labels = "v2") {
  const clean = String(name).toLowerCase().replace(/_/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const rules = labels === "v2" ? EXTRA_RULES_V2.concat(SECTION_RULES) : SECTION_RULES;
  for (const [type, pattern] of rules) if (pattern.test(clean)) return type;
  return "other";
}

const SECTION_EVENT = /^\s*(\d+)\s*=\s*E\s+"?\s*(?:\[\s*)?(?:section\s+([^"\]\r\n]+)|prc_([^"\]\r\n]+))/i;

// read_sections: [beat, SECTION_TYPES index], one per beat (a later name on
// the same beat wins); v2 merges consecutive sections of one type.
function chartSections(eventLines, resolution, sectionTypes, labels = "v2") {
  const res = Math.max(1, resolution);
  const byBeat = new Map();
  for (const line of eventLines) {
    const m = line.match(SECTION_EVENT);
    if (!m) continue;
    const type = normalizeSectionName(m[2] || m[3], labels);
    byBeat.set(pyRound(Number(m[1]) / res), sectionTypes.indexOf(type));
  }
  let sections = [...byBeat.entries()].sort((a, b) => a[0] - b[0]);
  if (labels === "v2") sections = sections.filter((s, i) => i === 0 || s[1] !== sections[i - 1][1]);
  return sections;
}

// One difficulty of a .chart as stream events plus its structure markers.
function readChartStream(chartText, difficulty, { sectionTypes = [], sectionLabels = "v2" } = {}) {
  const sections = parseChartSections(chartText);
  const resolution = chartResolution(sections.Song);
  const track = sections[TRACK_BY_DIFFICULTY[difficulty] || TRACK_BY_DIFFICULTY.expert] || [];
  return {
    resolution,
    events: trackEvents(track, resolution),
    solos: soloSpans(track, resolution),
    sections: sectionTypes.length ? chartSections(sections.Events || [], resolution, sectionTypes, sectionLabels) : [],
  };
}

// encode_events with the structure prefix flags and markers. bins: one per
// knob (DESC_AUTO_BIN = auto). Events at or past nBeats are dropped.
// sectionFlag: generation always asks for sections (see the manifest's
// structure.sectionFlag); training set it from the chart.
function encodeStream(events, nBeats, { difficulty, bins = null, solos = [], sections = [], structure = null, sectionFlag = sections.length > 0 }) {
  const knobBins = bins || new Array(N_DESCRIPTORS).fill(DESC_AUTO_BIN);
  const tokens = [BOS_TOKEN, difficultyToken(difficulty)];
  for (let k = 0; k < N_DESCRIPTORS; k += 1) tokens.push(descriptorToken(k, knobBins[k]));
  const markers = new Map();
  const slot = (beat) => {
    if (!markers.has(beat)) markers.set(beat, [0, 0, 0]);
    return markers.get(beat);
  };
  if (structure) {
    tokens.push(Number(solos.length ? structure.SOLO_FLAG_ON : structure.SOLO_FLAG_OFF));
    tokens.push(Number(sectionFlag ? structure.SECTION_FLAG_ON : structure.SECTION_FLAG_OFF));
    // per beat: solo end, then section, then solo start
    for (const [, end] of solos) if (end !== null) slot(end)[0] = Number(structure.SOLO_END_TOKEN);
    for (const [beat, index] of sections) slot(beat)[1] = Number(structure.SECTION_BASE) + index;
    for (const [start] of solos) slot(start)[2] = Number(structure.SOLO_START_TOKEN);
  }
  const ordered = events.slice().sort((a, b) => a.beat - b.beat || a.tick - b.tick);
  const susIndex = new Map(SUSTAIN_BUCKET_TICKS.map((edge, i) => [edge, i]));
  let e = 0;
  for (let beat = 0; beat < nBeats; beat += 1) {
    tokens.push(BEAT_TOKEN);
    for (const token of markers.get(beat) || []) if (token) tokens.push(token);
    while (e < ordered.length && ordered[e].beat < beat) e += 1;
    while (e < ordered.length && ordered[e].beat === beat) {
      const event = ordered[e];
      tokens.push(POS_BASE + event.tick);
      if (event.is_hopo) tokens.push(MOD_HOPO_TOKEN);
      if (event.is_tap) tokens.push(MOD_TAP_TOKEN);
      tokens.push(event.is_open ? OPEN_TOKEN : NOTE_BASE + event.bitmap - 1);
      if (susIndex.has(event.sustain_ticks)) tokens.push(SUS_BASE + susIndex.get(event.sustain_ticks));
      e += 1;
    }
  }
  tokens.push(EOS_TOKEN);
  return tokens;
}

// ---- descriptors (v2): the three Regenerate's style picks move ----

const DESCRIPTOR_BIN_EDGES_V2 = {
  speed: [5.5, 7.0, 8.5, 9.5, 11.5, 13.5],
  chords: [0.0281, 0.0808, 0.1397, 0.2114, 0.3103, 0.4662],
  movement: [0.6107, 0.7881, 0.9297, 1.047, 1.1511, 1.2711],
};

function eventSeconds(event, beatTimes) {
  const pos = event.beat + event.tick / TICKS_PER_BEAT;
  const last = beatTimes.length - 1;
  if (pos <= 0) return beatTimes[0];
  if (pos >= last) return beatTimes[last];
  const i = Math.floor(pos);
  return beatTimes[i] + (pos - i) * (beatTimes[i + 1] - beatTimes[i]);
}

// numpy percentile, linear interpolation.
function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const rank = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

function isChord(event) {
  if (event.is_open) return false;
  let n = 0;
  for (let b = event.bitmap; b; b &= b - 1) n += 1;
  return n >= 2;
}

function bitmapCenter(bitmap) {
  let sum = 0;
  let n = 0;
  for (let fret = 0; fret < 5; fret += 1) if (bitmap & (1 << fret)) { sum += fret; n += 1; }
  return sum / n;
}

// Raw speed / chords / movement of a run of events (time order).
function computeDescriptors(events, beatTimes) {
  if (!events.length) return { speed: 0, chords: 0, movement: 0 };
  const times = events.map((event) => eventSeconds(event, beatTimes));
  const ordered = times.slice().sort((a, b) => a - b);
  const rates = [];
  let start = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    while (ordered[start] < ordered[i] - 2.0) start += 1;
    rates.push((i - start + 1) / 2.0);
  }
  rates.sort((a, b) => a - b);
  const deltas = [];
  let prevCenter = null;
  let prevTime = null;
  events.forEach((event, i) => {
    if (event.is_open || event.bitmap === 0) return;
    const center = bitmapCenter(event.bitmap);
    if (prevCenter !== null && times[i] - prevTime <= 2.0) deltas.push(Math.abs(center - prevCenter));
    prevCenter = center;
    prevTime = times[i];
  });
  return {
    speed: percentile(rates, 90),
    chords: events.filter(isChord).length / events.length,
    movement: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0,
  };
}

function descriptorBin(name, value) {
  const edges = DESCRIPTOR_BIN_EDGES_V2[name];
  let bin = 0;
  while (bin < edges.length && edges[bin] <= value) bin += 1;
  return bin;
}

// ---- writing fills back ----

const LINE = /^\s*(\d+)\s*=\s*(\S+)\s*(.*?)\s*$/;

// Replaces one difficulty's notes inside each span [startTick, endTick) with
// that span's [tick, type, sustain] note lines. Solo markers and star power
// stay. Within a tick: E solo, then notes, then E soloend.
function spliceTrackNotes(chartText, difficulty, spans) {
  const lines = String(chartText).split(/\r?\n/);
  const header = `[${TRACK_BY_DIFFICULTY[difficulty] || TRACK_BY_DIFFICULTY.expert}]`;
  const at = lines.findIndex((line) => line.trim() === header);
  if (at < 0) throw new Error(`The chart has no ${header} track.`);
  const open = at + 1;
  if (lines[open]?.trim() !== "{") throw new Error(`The chart's ${header} track is malformed.`);
  let close = open + 1;
  while (close < lines.length && lines[close].trim() !== "}") close += 1;
  const body = lines.slice(open + 1, close);
  const indent = (body.find((line) => line.trim()) || "  ").match(/^\s*/)[0];
  const inSpan = (tick) => spans.some((span) => tick >= span.startTick && tick < span.endTick);
  const rank = (type, rest) => (type === "E" && /^"?solo"?$/i.test(rest) ? 0 : type === "E" && /^"?soloend"?$/i.test(rest) ? 2 : 1);
  const rows = [];
  for (const line of body) {
    const m = line.match(LINE);
    if (!m) continue;
    const tick = Number(m[1]);
    if (m[2] === "N" && inSpan(tick)) continue;
    rows.push({ tick, rank: rank(m[2], m[3]), text: line });
  }
  for (const span of spans) {
    for (const [tick, type, sustain] of span.noteLines) rows.push({ tick, rank: 1, text: `${indent}${tick} = N ${type} ${sustain}` });
  }
  rows.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  return [...lines.slice(0, open + 1), ...rows.map((row) => row.text), ...lines.slice(close)].join("\n");
}

export {
  TRACK_BY_DIFFICULTY,
  spliceTrackNotes,
  pyRound,
  readChartStream,
  encodeStream,
  normalizeSectionName,
  computeDescriptors,
  descriptorBin,
};
