// Parser for the Clone Hero / Moonscraper `.chart` text format.
//
// The format is a series of `[SectionName]` blocks wrapped in `{ ... }`, each
// line of the form `tick = TYPE params...`. See the notes in
// memory/highway-design-decisions for the gotchas this handles:
//   - BPM is stored x1000 (`B 130000` => 130.000 BPM)
//   - note "fret" values: 0-4 = G/R/Y/B/O, 5 = force, 6 = tap, 7 = open
//   - chords are multiple `N` lines sharing a tick
//   - `S` lines are star-power phrases interleaved in the note track
//   - lines may carry trailing whitespace

// Maps a `.chart` difficulty track name to a friendly difficulty key.
export const TRACK_BY_DIFFICULTY = {
  expert: "ExpertSingle",
  hard: "HardSingle",
  medium: "MediumSingle",
  easy: "EasySingle",
};

// Special "fret" numbers that are modifier flags rather than playable lanes.
const FRET_FORCE = 5;
const FRET_TAP = 6;
const FRET_OPEN = 7;

// Splits the raw text into `{ [sectionName]: string[] }` of body lines,
// stripping the surrounding braces and blank lines.
function splitSections(text) {
  const sections = {};
  // Normalize newlines and a possible UTF-8 BOM.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);

  let current = null;
  let body = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (current === null) {
      const header = line.match(/^\[(.+)\]$/);
      if (header) {
        current = header[1];
        body = [];
      }
      continue;
    }

    if (line === "{") continue;
    if (line === "}") {
      sections[current] = body;
      current = null;
      body = null;
      continue;
    }
    body.push(line);
  }
  return sections;
}

// Parses a `key = value` body line. Values that look like `"quoted"` are
// unquoted; the rest is returned verbatim (callers split on whitespace).
function parseKeyValue(line) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  const quoted = value.match(/^"(.*)"$/);
  if (quoted) value = quoted[1];
  return { key, value };
}

function unquoteValue(value) {
  const quoted = String(value || "").match(/^"(.*)"$/);
  return quoted ? quoted[1] : value;
}

// [Song] -> metadata object. Resolution (ticks per quarter note) and Offset
// are coerced to numbers; everything else stays a string.
function parseSong(body) {
  const meta = {};
  for (const line of body || []) {
    const kv = parseKeyValue(line);
    if (!kv) continue;
    meta[kv.key] = kv.value;
  }
  return {
    name: meta.Name || "",
    artist: meta.Artist || "",
    charter: meta.Charter || "",
    genre: meta.Genre || "",
    // Ticks per quarter note. Defaults to the Moonscraper standard of 192.
    resolution: Number(meta.Resolution) || 192,
    // Chart-level offset in seconds, applied to audio (positive = audio late).
    offset: Number(meta.Offset) || 0,
    musicStream: meta.MusicStream || "",
    raw: meta,
  };
}

// [SyncTrack] -> sorted lists of tempo (BPM) and time-signature events.
// `B <bpm*1000>` and `TS <numerator> [denominatorExp]`.
function parseSyncTrack(body) {
  const bpms = [];
  const timeSignatures = [];
  for (const line of body || []) {
    const kv = parseKeyValue(line);
    if (!kv) continue;
    const tick = Number(kv.key);
    const parts = kv.value.split(/\s+/);
    const type = parts[0];
    if (type === "B") {
      bpms.push({ tick, bpm: Number(parts[1]) / 1000 });
    } else if (type === "TS") {
      timeSignatures.push({
        tick,
        numerator: Number(parts[1]),
        // Denominator is stored as a power of two; absent means 4.
        denominator: parts[2] !== undefined ? 2 ** Number(parts[2]) : 4,
      });
    }
  }
  bpms.sort((a, b) => a.tick - b.tick);
  timeSignatures.sort((a, b) => a.tick - b.tick);
  return { bpms, timeSignatures };
}

// [Events] -> global events. We surface section markers, lyric markers, and
// other chart text events for consumers such as the highway renderer.
function parseEvents(body) {
  const events = [];
  for (const line of body || []) {
    const kv = parseKeyValue(line);
    if (!kv) continue;
    const tick = Number(kv.key);
    // `E "text"` carries quotes inside the value, so strip those after `E`.
    if (kv.value.startsWith("E ") || kv.value === "E") {
      events.push({ tick, text: unquoteValue(kv.value.replace(/^E\s*/, "")) });
    } else {
      events.push({ tick, text: unquoteValue(kv.value) });
    }
  }
  events.sort((a, b) => a.tick - b.tick);
  return events;
}

// Parses a single instrument difficulty track (e.g. [ExpertSingle]).
// Returns grouped notes plus star-power phrases.
//
// Raw `N <fret> <sustainTicks>` lines are first collected per tick, then
// folded into note objects so a chord becomes one entry with multiple frets.
function parseNoteTrack(body) {
  // tick -> { frets:Set, sustain:Map(fret->ticks), force, tap, open }
  const byTick = new Map();
  const starPower = [];

  const ensure = (tick) => {
    let entry = byTick.get(tick);
    if (!entry) {
      entry = {
        tick,
        frets: new Set(),
        sustain: new Map(),
        force: false,
        tap: false,
        open: false,
      };
      byTick.set(tick, entry);
    }
    return entry;
  };

  for (const line of body || []) {
    const kv = parseKeyValue(line);
    if (!kv) continue;
    const tick = Number(kv.key);
    const parts = kv.value.split(/\s+/);
    const type = parts[0];

    if (type === "N") {
      const fret = Number(parts[1]);
      const sustain = Number(parts[2]) || 0;
      const entry = ensure(tick);
      if (fret === FRET_FORCE) entry.force = true;
      else if (fret === FRET_TAP) entry.tap = true;
      else if (fret === FRET_OPEN) {
        entry.open = true;
        entry.sustain.set("open", sustain);
      } else {
        entry.frets.add(fret);
        entry.sustain.set(fret, sustain);
      }
    } else if (type === "S") {
      // Star power: `S <type> <durationTicks>`. Type 2 is the SP phrase.
      starPower.push({
        tick,
        kind: Number(parts[1]),
        length: Number(parts[2]) || 0,
      });
    }
    // Other line types (e.g. track-local `E` events) are ignored for now.
  }

  const notes = [];
  for (const entry of byTick.values()) {
    const frets = entry.open ? [] : [...entry.frets].sort((a, b) => a - b);
    // Longest sustain across the chord drives the note's tail length.
    let sustain = 0;
    for (const s of entry.sustain.values()) sustain = Math.max(sustain, s);
    notes.push({
      tick: entry.tick,
      frets, // empty array means an open note
      open: entry.open,
      sustain,
      force: entry.force,
      tap: entry.tap,
    });
  }
  notes.sort((a, b) => a.tick - b.tick);
  starPower.sort((a, b) => a.tick - b.tick);
  return { notes, starPower };
}

// Parses a full `.chart` file into structured data. Note ticks are NOT yet
// converted to seconds — that requires the tempo map (see tempoMap.js).
export function parseChart(text) {
  const sections = splitSections(text);
  const song = parseSong(sections.Song);
  const sync = parseSyncTrack(sections.SyncTrack);
  const events = parseEvents(sections.Events);

  // Collect every instrument difficulty track that is present.
  const tracks = {};
  for (const [diff, sectionName] of Object.entries(TRACK_BY_DIFFICULTY)) {
    if (sections[sectionName]) {
      tracks[diff] = parseNoteTrack(sections[sectionName]);
    }
  }

  return {
    song,
    sync,
    events,
    tracks,
    // Section names that we did not interpret (e.g. GHL tracks), for debugging.
    unknownSections: Object.keys(sections).filter(
      (name) =>
        name !== "Song" &&
        name !== "SyncTrack" &&
        name !== "Events" &&
        !Object.values(TRACK_BY_DIFFICULTY).includes(name)
    ),
  };
}
