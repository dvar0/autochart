"use strict";

// Beat-aligned mel pipeline (mirrors the training-time feature recipe).
// Mel on six monos (full + four stems + non_drums = bass+vocals+other); non_drums
// only supplies shared ref_db and is dropped before the stack. Output stacks
// CHANNEL_ORDER -> [n_beats, 5, 80, 32]. Beat windows: 32 points at
// t_i + (j+0.5)/32*(t_{i+1}-t_i), fractional frame + linear interp (Python parity).

const { createSession, tensor, runSession } = require("./sessionLoader.cjs");
const { graphPath } = require("./modelsManifest.cjs");

const CHANNEL_ORDER = ["full", "drums", "bass", "vocals", "other"];
const FRAME_DURATION = 512 / 22050; // 0.023219954648526078
const FRAMES_PER_BEAT = 32;
const MEL_DB_FLOOR = -80.0;
const MEL_DB_OFFSET = 40.0;
const MEL_DB_SCALE = 40.0;

async function loadMelSession(manifest, device = "cpu") {
  return createSession(graphPath(manifest, "transcriber-mel"), { device });
}

async function runMelGraph(session, mono) {
  const wavT = tensor("float32", mono, [mono.length]);
  const out = await runSession(session, { wav: wavT });
  const mel = await out.mel_db.getData(true);
  const dims = out.mel_db.dims;
  return {
    mel,
    nMels: dims[0],
    nFrames: dims[1],
  };
}

function normalizeMelDb(mel) {
  const out = new Float32Array(mel.length);
  for (let i = 0; i < mel.length; i += 1) {
    let v = mel[i];
    if (v < MEL_DB_FLOOR) v = MEL_DB_FLOOR;
    else if (v > 0) v = 0;
    out[i] = (v + MEL_DB_OFFSET) / MEL_DB_SCALE;
  }
  return out;
}

function beatMelWindowsForChannel(mel, nMels, nFrames, beatTimes) {
  const nBeats = beatTimes.length - 1;
  const out = new Float32Array(nBeats * nMels * FRAMES_PER_BEAT);
  const offsets = new Float64Array(FRAMES_PER_BEAT);
  for (let j = 0; j < FRAMES_PER_BEAT; j += 1) {
    offsets[j] = (j + 0.5) / FRAMES_PER_BEAT;
  }
  for (let beat = 0; beat < nBeats; beat += 1) {
    const start = beatTimes[beat];
    const end = beatTimes[beat + 1];
    const span = end - start;
    for (let j = 0; j < FRAMES_PER_BEAT; j += 1) {
      const f = (start + offsets[j] * span) / FRAME_DURATION;
      const idx0raw = Math.floor(f);
      let idx0 = idx0raw;
      if (idx0 < 0) idx0 = 0;
      else if (idx0 > nFrames - 1) idx0 = nFrames - 1;
      let idx1 = idx0 + 1;
      if (idx1 < 0) idx1 = 0;
      else if (idx1 > nFrames - 1) idx1 = nFrames - 1;
      const frac = f - idx0raw;
      const w0 = 1 - frac;
      const w1 = frac;
      const outOff = (beat * nMels) * FRAMES_PER_BEAT + j;
      for (let m = 0; m < nMels; m += 1) {
        const mIdx0 = m * nFrames + idx0;
        const mIdx1 = m * nFrames + idx1;
        out[outOff + m * FRAMES_PER_BEAT] = mel[mIdx0] * w0 + mel[mIdx1] * w1;
      }
    }
  }
  return out;
}

async function buildBeatMel({
  melSession,
  fullMono22050,
  stemMonos22050,
  beatTimes,
  maxBeats = 1280,
  audioDuration = null,
  log = null,
}) {
  const channels = {
    full: fullMono22050,
    drums: stemMonos22050.drums,
    bass: stemMonos22050.bass,
    vocals: stemMonos22050.vocals,
    other: stemMonos22050.other,
  };
  const commonLen = Math.max(
    channels.full.length,
    channels.drums.length,
    channels.bass.length,
    channels.vocals.length,
    channels.other.length
  );
  const nonDrums = new Float32Array(commonLen);
  for (const name of ["bass", "vocals", "other"]) {
    const ch = channels[name];
    for (let i = 0; i < ch.length; i += 1) nonDrums[i] += ch[i];
  }

  function padded(ch) {
    if (ch.length === commonLen) return ch;
    const out = new Float32Array(commonLen);
    out.set(ch, 0);
    return out;
  }
  const channelList = [
    ["full", padded(channels.full)],
    ["drums", padded(channels.drums)],
    ["bass", padded(channels.bass)],
    ["vocals", padded(channels.vocals)],
    ["other", padded(channels.other)],
    ["non_drums", nonDrums],
  ];

  const mels = {};
  let maxMel = -Infinity;
  for (const [name, mono] of channelList) {
    if (log) log(`  mel: graph on channel ${name} (${mono.length} samples = ${(mono.length / 22050).toFixed(1)}s)`);
    const { mel, nMels, nFrames } = await runMelGraph(melSession, mono);
    if (nMels !== 80) throw new Error(`transcriber mel: expected 80 mels, got ${nMels}`);
    mels[name] = { mel, nMels, nFrames };
    for (let i = 0; i < mel.length; i += 1) {
      if (mel[i] > maxMel) maxMel = mel[i];
    }
  }
  const refDb = maxMel;
  if (log) log(`  mel: shared ref_db=${refDb.toFixed(4)} dB`);

  let nFramesFinal = Infinity;
  for (const name of CHANNEL_ORDER) {
    if (mels[name].nFrames < nFramesFinal) nFramesFinal = mels[name].nFrames;
  }

  const normed = {};
  for (const name of CHANNEL_ORDER) {
    const { mel, nFrames } = mels[name];
    const shared = new Float32Array(80 * nFramesFinal);
    for (let m = 0; m < 80; m += 1) {
      for (let t = 0; t < nFramesFinal; t += 1) {
        shared[m * nFramesFinal + t] = mel[m * nFrames + t] - refDb;
      }
    }
    normed[name] = normalizeMelDb(shared);
  }

  let nBeats = beatTimes.length - 1;
  if (audioDuration != null && Number.isFinite(audioDuration)) {
    let capped = 0;
    for (let idx = 0; idx < beatTimes.length - 1; idx += 1) {
      if (beatTimes[idx + 1] <= audioDuration) capped = idx + 1;
      else break;
    }
    if (capped < nBeats) nBeats = capped;
  }
  if (nBeats > maxBeats) nBeats = maxBeats;
  if (nBeats < 1) {
    throw new Error(`buildBeatMel: n_beats < 1 (beatTimes.len=${beatTimes.length}, audioDur=${audioDuration})`);
  }
  if (log) log(`  beat_mel: n_beats=${nBeats} (max_beats=${maxBeats}, audio_dur=${audioDuration})`);

  const clippedBeats = beatTimes.length === nBeats + 1
    ? beatTimes
    : beatTimes.subarray ? beatTimes.subarray(0, nBeats + 1) : beatTimes.slice(0, nBeats + 1);

  const out = new Float32Array(nBeats * 5 * 80 * FRAMES_PER_BEAT);
  const strideBeat = 5 * 80 * FRAMES_PER_BEAT;
  const strideChannel = 80 * FRAMES_PER_BEAT;
  for (let c = 0; c < 5; c += 1) {
    const name = CHANNEL_ORDER[c];
    const channelMel = normed[name];
    const win = beatMelWindowsForChannel(channelMel, 80, nFramesFinal, clippedBeats);
    for (let beat = 0; beat < nBeats; beat += 1) {
      const dstOff = beat * strideBeat + c * strideChannel;
      out.set(win.subarray(beat * 80 * FRAMES_PER_BEAT, (beat + 1) * 80 * FRAMES_PER_BEAT), dstOff);
    }
  }

  const beatMask = new Uint8Array(nBeats).fill(1);
  return { beatMel: out, beatMask, nBeats, nFramesFinal, refDb };
}

module.exports = {
  buildBeatMel,
  loadMelSession,
  runMelGraph,
  normalizeMelDb,
  beatMelWindowsForChannel,
  CHANNEL_ORDER,
  FRAME_DURATION,
  FRAMES_PER_BEAT,
};