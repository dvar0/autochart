"use strict";

const chartWriter = require("../../../shared/chartWriter.cjs");

// Faithful JS port of the reference Python event-stream + chart-writer logic.
// Pure logic, no ONNX, no audio. Kept in lock-step spec with the reference:
//
//   PAD=0 BOS=1 EOS=2 BEAT=3 DIFF_BASE=4 (expert/hard/medium/easy)
//   POS_BASE=8 (48 within-beat positions) NOTE_BASE=56 (bitmap 1..31)
//   OPEN_TOKEN=87 MOD_HOPO=88 MOD_TAP=89 SUS_BASE=90 (12 buckets)
//   INTENSITY_BASE=102 DESC_BASE=110 (5 knobs x 8 bins + auto) VOCAB_SIZE=150
//
// decode_tokens is a tolerant state machine; events_to_chart_notes maps the
// 48-tick-per-beat grid to chart ticks at resolution 192 (=48*4): absTick = beat*192
// + round(tick*192/48). Final and streamed charts share the same metadata writer.

const TICKS_PER_BEAT = 48;
const SUSTAIN_BUCKET_TICKS = [12, 24, 36, 48, 72, 96, 144, 192, 288, 384, 576, 768];
const DIFFICULTY_NAMES = ["expert", "hard", "medium", "easy"];
const INTENSITY_NAMES = ["low", "2", "3", "4", "5", "6", "ultra", "unknown"];

const PAD_TOKEN = 0;
const BOS_TOKEN = 1;
const EOS_TOKEN = 2;
const BEAT_TOKEN = 3;
const DIFF_BASE = 4; // 4..7
const POS_BASE = DIFF_BASE + DIFFICULTY_NAMES.length; // 8..55
const NOTE_BASE = POS_BASE + TICKS_PER_BEAT; // 56..86 bitmap 1..31
const OPEN_TOKEN = NOTE_BASE + 31; // 87
const MOD_HOPO_TOKEN = 88;
const MOD_TAP_TOKEN = 89;
const SUS_BASE = 90; // 90..101
const INTENSITY_BASE = SUS_BASE + SUSTAIN_BUCKET_TICKS.length; // 102..109
const N_DESCRIPTORS = 5;
const DESCRIPTOR_BIN_COUNT = 8; // 7 bins + auto (bin index 7)
const DESC_BASE = INTENSITY_BASE + INTENSITY_NAMES.length; // 110..149
const VOCAB_SIZE = DESC_BASE + N_DESCRIPTORS * DESCRIPTOR_BIN_COUNT; // 150
const DESCRIPTOR_NAMES = ["speed", "chords", "technique", "movement", "repetition"];
const DESC_PREFIX_SCAN = 8;
const DESC_AUTO_BIN = DESCRIPTOR_BIN_COUNT - 1;

function difficultyToken(name) {
  const idx = DIFFICULTY_NAMES.indexOf(String(name).toLowerCase());
  if (idx < 0) throw new Error(`difficulty_token: unknown difficulty ${name}`);
  return DIFF_BASE + idx;
}

function intensityToken(name) {
  const idx = INTENSITY_NAMES.indexOf(String(name).toLowerCase());
  if (idx < 0) throw new Error(`intensity_token: unknown intensity ${name}`);
  return INTENSITY_BASE + idx;
}

function descriptorToken(knobIndex, binIndex) {
  if (knobIndex < 0 || knobIndex >= N_DESCRIPTORS) {
    throw new Error(`descriptor_token: knob out of range ${knobIndex}`);
  }
  if (binIndex < 0 || binIndex >= DESCRIPTOR_BIN_COUNT) {
    throw new Error(`descriptor_token: bin out of range ${binIndex}`);
  }
  return DESC_BASE + knobIndex * DESCRIPTOR_BIN_COUNT + binIndex;
}

// Port of DecodeIssues dataclass.
function newIssues() {
  return {
    orphan_modifiers: 0,
    orphan_positions: 0,
    notes_without_position: 0,
    duplicate_positions: 0,
    details: [],
  };
}

// decode_tokens: tolerant state machine.
// Returns { events: StreamEvent[], issues }.
function decodeTokens(tokens) {
  const issues = newIssues();
  const events = [];
  let beat = -1;
  let pendingPos = null;
  let pendingHopo = false;
  let pendingTap = false;

  function dropPending(reason) {
    if (pendingPos !== null) {
      issues.orphan_positions += 1;
      issues.details.push(reason);
    } else if (pendingHopo || pendingTap) {
      issues.orphan_modifiers += 1;
    }
    pendingPos = null;
    pendingHopo = false;
    pendingTap = false;
  }

  for (const raw of tokens) {
    const token = Number(raw) | 0;
    if (token === PAD_TOKEN || token === BOS_TOKEN || (DIFF_BASE <= token && token < POS_BASE)) {
      continue;
    }
    if (INTENSITY_BASE <= token && token < VOCAB_SIZE) {
      // INT and DESC ranges serve only as conditioning; skip on decode.
      continue;
    }
    if (token === EOS_TOKEN) {
      break;
    }
    if (token === BEAT_TOKEN) {
      dropPending(`position open at beat advance (beat ${beat})`);
      beat += 1;
      continue;
    }
    if (POS_BASE <= token && token < NOTE_BASE) {
      if (pendingPos !== null) {
        issues.duplicate_positions += 1;
      }
      pendingPos = token - POS_BASE;
      continue;
    }
    if (token === MOD_HOPO_TOKEN) {
      pendingHopo = true;
      continue;
    }
    if (token === MOD_TAP_TOKEN) {
      pendingTap = true;
      continue;
    }
    if (NOTE_BASE <= token && token <= OPEN_TOKEN) {
      if (pendingPos === null) {
        issues.notes_without_position += 1;
        continue;
      }
      const isOpen = token === OPEN_TOKEN;
      events.push({
        beat: Math.max(beat, 0),
        tick: pendingPos,
        bitmap: isOpen ? 0 : token - NOTE_BASE + 1,
        is_open: isOpen,
        is_hopo: pendingHopo,
        is_tap: pendingTap,
        sustain_ticks: 0,
      });
      pendingPos = null;
      pendingHopo = false;
      pendingTap = false;
      continue;
    }
    if (SUS_BASE <= token && token < INTENSITY_BASE) {
      if (events.length && !events[events.length - 1].sustain_ticks) {
        events[events.length - 1].sustain_ticks = SUSTAIN_BUCKET_TICKS[token - SUS_BASE];
      }
      continue;
    }
  }
  dropPending("position open at end of stream");
  return { events, issues };
}

// eventsToChartNotes: maps grid events to chart rows. resolution default 192.
// Returns rows: array of [tick, note_type, sustain_ticks, modifier_types[]].
// Modifier types per .chart: 5 = forced hopo, 6 = tap.
function eventsToChartNotes(events, resolution = 192) {
  const rows = [];
  const sorted = events.slice().sort((a, b) => gridTick(a) - gridTick(b));
  for (const event of sorted) {
    const tick = Math.round((gridTick(event) * resolution) / TICKS_PER_BEAT);
    const sustain = Math.round((event.sustain_ticks * resolution) / TICKS_PER_BEAT);
    const modifiers = [];
    if (event.is_hopo) modifiers.push(5);
    if (event.is_tap) modifiers.push(6);
    if (event.is_open) {
      rows.push([tick, 7, sustain, modifiers]);
    } else {
      for (let fret = 0; fret < 5; fret += 1) {
        if (event.bitmap & (1 << fret)) rows.push([tick, fret, sustain, modifiers]);
      }
    }
  }
  return rows;
}

function gridTick(event) {
  return event.beat * TICKS_PER_BEAT + event.tick;
}

// flattenNoteLines: collapse rows into unique chart lines.
// Returns unique [tick, note_type, sustain] lines (modifiers become their own
// N lines with sustain=0) and sorts ascending.
function flattenNoteLines(rows) {
  const noteLines = [];
  const seen = new Set();
  for (const [tick, noteType, sustain, modifiers] of rows) {
    const lines = [[tick, noteType, sustain]];
    for (const m of modifiers) lines.push([tick, m, 0]);
    for (const line of lines) {
      const key = line.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        noteLines.push(line);
      }
    }
  }
  noteLines.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return noteLines;
}

function writeChartText(rows, options = {}) {
  return chartWriter.writeChartText(flattenNoteLines(rows), options);
}

// Tempo / SyncTrack helpers: build the chart SYNC block from the beat grid.
// Used to build the chart SyncTrack from the detected beat grid.
function beatsToSyncLines(beatTimes, resolution, bpmRound = 0.5) {
  const lines = ["0 = TS 4"];
  let previousBpm = null;
  for (let i = 0; i + 1 < beatTimes.length; i += 1) {
    const duration = beatTimes[i + 1] - beatTimes[i];
    let bpm = Math.round(60.0 / duration / bpmRound) * bpmRound;
    if (bpm < bpmRound) bpm = bpmRound;
    if (bpm !== previousBpm) {
      lines.push(`${i * resolution} = B ${Math.round(bpm * 1000)}`);
      previousBpm = bpm;
    }
  }
  return lines;
}

// trimSustainsFromTokens: drop SUS_* / INT_* tokens.
// Note: per project hard rule, sustains are NEVER stripped at generation; this
// helper exists for completeness / parity only and is not called by the generator.
function stripSustainsFromTokens(tokens) {
  const out = [];
  for (const t of tokens) {
    if (SUS_BASE <= t && t < INTENSITY_BASE) continue;
    out.push(t);
  }
  return out;
}

module.exports = {
  TICKS_PER_BEAT,
  SUSTAIN_BUCKET_TICKS,
  DIFFICULTY_NAMES,
  INTENSITY_NAMES,
  PAD_TOKEN,
  BOS_TOKEN,
  EOS_TOKEN,
  BEAT_TOKEN,
  DIFF_BASE,
  POS_BASE,
  NOTE_BASE,
  OPEN_TOKEN,
  MOD_HOPO_TOKEN,
  MOD_TAP_TOKEN,
  SUS_BASE,
  INTENSITY_BASE,
  N_DESCRIPTORS,
  DESCRIPTOR_BIN_COUNT,
  DESC_BASE,
  VOCAB_SIZE,
  DESCRIPTOR_NAMES,
  DESC_PREFIX_SCAN,
  DESC_AUTO_BIN,
  difficultyToken,
  intensityToken,
  descriptorToken,
  decodeTokens,
  eventsToChartNotes,
  flattenNoteLines,
  writeChartText,
  beatsToSyncLines,
  stripSustainsFromTokens,
  gridTick,
  newIssues,
};