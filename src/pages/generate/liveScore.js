// What the live board knows about the song while a run gets ready: the mix's
// loudness, each stem's as the separation finishes it, and the beats as they
// are found (the engine's `song_map` events, engine/lib/onnx/songMap.mjs). The
// separation and the beat finder both work through the song in order, so their
// `stage` progress is a position in the song. Times are performance.now(), so
// the board can animate what just changed.

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const easeOut = (x) => 1 - (1 - x) ** 3;

// Lanes from the top: high to low, like light out of a prism.
export const STEM_LANES = ["vocals", "guitar", "other", "bass", "drums"];

const SWEEP_MS = 650;

// A stage's progress through the song, eased from where it was shown to the
// new value over about as long as the last step took, so it never runs ahead.
function progressTo(prev, value, at) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  if (!prev) return { from: 0, value: v, at, dur: 300 };
  const from = progressAt(prev, at);
  return { from, value: Math.max(v, from), at, dur: Math.max(120, Math.min(2500, at - prev.at)) };
}

// Everything known at once (a reused separation): one quick pass.
const sweep = (at) => ({ from: 0, value: 1, at, dur: SWEEP_MS });

export function progressAt(progress, t) {
  if (!progress) return 0;
  const k = progress.dur > 0 ? Math.max(0, Math.min(1, (t - progress.at) / progress.dur)) : 1;
  return progress.from + (progress.value - progress.from) * easeOut(k);
}

function startMap(at) {
  return {
    phase: "read",
    phaseAt: at,
    rate: 0,
    seconds: 0,
    mix: null,
    stems: null,
    stemFrames: 0,
    noStems: false,
    split: null,
    beat: null,
    beats: [],
    downbeats: [],
    updatedAt: at,
  };
}

function atPhase(map, phase, at) {
  return map.phase === phase ? map : { ...map, phase, phaseAt: at };
}

function stageEvent(map, event, at) {
  const progress = typeof event.progress === "number" && Number.isFinite(event.progress) ? event.progress : null;
  if (event.stage === "demucs") {
    if (event.status === "skipped") return { ...map, noStems: true };
    if (event.downloading) return map;
    const next = atPhase(map, "split", at);
    return progress == null ? next : { ...next, split: progressTo(map.split, progress, at) };
  }
  if (event.stage === "timing" || event.stage === "smoothing") {
    const next = atPhase(map, "beat", at);
    return progress == null ? next : { ...next, beat: progressTo(map.beat, progress, at) };
  }
  if (event.stage === "transcription") return atPhase(map, "warm", at);
  return map;
}

function stemsEvent(map, event, at) {
  const frames = Math.ceil(map.seconds * map.rate);
  const from = Number(event.from) || 0;
  const stems = map.stems || {};
  let end = from;
  for (const [name, levels] of Object.entries(event.levels || {})) {
    const lane = stems[name] || (stems[name] = new Uint8Array(frames));
    lane.set(levels.slice(0, Math.max(0, frames - from)), from);
    end = Math.max(end, Math.min(frames, from + levels.length));
  }
  const whole = from === 0 && end >= frames;
  return { ...map, stems, stemFrames: Math.max(map.stemFrames, end), ...(whole ? { split: sweep(at) } : {}) };
}

function beatsEvent(map, event, at) {
  if (event.final) {
    return {
      ...map,
      beats: event.beats || [],
      downbeats: event.downbeats || [],
      gridFinal: true,
      beat: map.beat ? progressTo(map.beat, 1, at) : sweep(at),
    };
  }
  if (map.gridFinal) return map;
  // The last chunk overlaps the one before it.
  const after = (list, more) => {
    const last = list.length ? list[list.length - 1] : -1;
    return list.concat((more || []).filter((t) => t > last + 0.05));
  };
  return { ...map, beats: after(map.beats, event.beats), downbeats: after(map.downbeats, event.downbeats) };
}

export function mergeSongMap(map, event, at = now()) {
  if (!event || (event.type !== "stage" && event.type !== "song_map")) return map;
  const base = map || startMap(at);
  let next = base;
  if (event.type === "stage") next = stageEvent(base, event, at);
  else if (event.kind === "mix") {
    next = { ...base, rate: Number(event.rate) || 10, seconds: Number(event.seconds) || 0, mix: event.levels || [], mixAt: at };
  } else if (event.kind === "stems" && base.seconds > 0) next = stemsEvent(base, event, at);
  else if (event.kind === "beats") next = beatsEvent(base, event, at);
  return next === base ? base : { ...next, updatedAt: at };
}
