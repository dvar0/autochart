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
// Each glide takes a little longer than a step is expected to, so the next
// step usually lands while the position is still moving.
const STRETCH = 1.15;

// A stage's progress through the song. Steps come once per chunk; the shown
// position glides at a steady speed from where it is to the newest value,
// timed to the steps' recent pace. It trails the run by about one step and
// never runs ahead. `startAt` is when the stage began working, which times
// the first step.
function progressTo(prev, value, at, startAt = null) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  if (!prev) {
    const step = startAt != null && at - startAt > 50 ? at - startAt : 600;
    return { from: 0, value: v, at, dur: glide(step), pace: step, first: true };
  }
  const from = progressAt(prev, at);
  const step = at - prev.at;
  // The first step also carries the model's warm-up, so it doesn't set the pace.
  const pace = prev.first ? step : prev.pace * 0.6 + step * 0.4;
  return { from, value: Math.max(v, prev.value), at, dur: glide(pace), pace };
}

const glide = (pace) => Math.max(120, Math.min(4000, pace * STRETCH));

// Everything known at once (a reused separation): one quick pass.
const sweep = (at) => ({ from: 0, value: 1, at, dur: SWEEP_MS, ease: true });

export function progressAt(progress, t) {
  if (!progress) return 0;
  const k = progress.dur > 0 ? Math.max(0, Math.min(1, (t - progress.at) / progress.dur)) : 1;
  return progress.from + (progress.value - progress.from) * (progress.ease ? easeOut(k) : k);
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
    if (progress == null) return { ...next, splitStart: at };
    return { ...next, split: progressTo(map.split, progress, at, map.splitStart) };
  }
  if (event.stage === "timing" || event.stage === "smoothing") {
    const next = atPhase(map, "beat", at);
    if (progress == null) return map.beat ? next : { ...next, beatStart: at };
    return { ...next, beat: progressTo(map.beat, progress, at, map.beatStart) };
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
