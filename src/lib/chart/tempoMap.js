// Converts chart ticks to absolute seconds using the SyncTrack tempo map.
//
// In a `.chart`, note positions are stored in ticks. `Resolution` ticks make
// one quarter note. Tempo (`B` events) can change mid-song, so a fixed
// ticks->seconds ratio is wrong; we precompute the elapsed time at each tempo
// change and interpolate within each segment.

// Builds a tempo map from parsed sync data + resolution. Returns an object
// with a `tickToSeconds(tick)` method and the precomputed segments.
//
// Each segment records the tempo region starting at `tick`/`time` (seconds)
// with `secondsPerTick` for that region.
export function buildTempoMap(sync, resolution) {
  const bpms =
    sync.bpms && sync.bpms.length ? sync.bpms : [{ tick: 0, bpm: 120 }];

  // Ensure a tempo event exists at tick 0 so the first segment is well-defined.
  const events = bpms[0].tick === 0 ? bpms : [{ tick: 0, bpm: bpms[0].bpm }, ...bpms];

  const segments = [];
  let elapsed = 0; // seconds at the start of the current segment
  for (let i = 0; i < events.length; i++) {
    const { tick, bpm } = events[i];
    // seconds per tick = (60 / bpm) seconds-per-beat / resolution ticks-per-beat
    const secondsPerTick = 60 / (bpm * resolution);
    if (i > 0) {
      const prev = segments[i - 1];
      elapsed += (tick - prev.tick) * prev.secondsPerTick;
    }
    segments.push({ tick, time: elapsed, bpm, secondsPerTick });
  }

  function tickToSeconds(tick) {
    // Find the last segment whose tick is <= the queried tick.
    let seg = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].tick <= tick) seg = segments[i];
      else break;
    }
    return seg.time + (tick - seg.tick) * seg.secondsPerTick;
  }

  // Inverse of tickToSeconds: maps absolute seconds back to a chart tick.
  // Used by the editor for click-to-place and seek-to-tick conversions.
  function secondsToTick(seconds) {
    const t = Number.isFinite(seconds) ? seconds : 0;
    // Find the last segment whose start time is <= the queried time.
    let seg = segments[0];
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].time <= t) seg = segments[i];
      else break;
    }
    if (!seg.secondsPerTick) return seg.tick;
    return seg.tick + (t - seg.time) / seg.secondsPerTick;
  }

  return { segments, tickToSeconds, secondsToTick };
}

// Annotates every note (and its sustain tail) with absolute seconds.
// Returns a new array; does not mutate the input.
export function resolveNoteTimes(notes, tempoMap) {
  return notes.map((note) => {
    const time = tempoMap.tickToSeconds(note.tick);
    const endTime =
      note.sustain > 0
        ? tempoMap.tickToSeconds(note.tick + note.sustain)
        : time;
    return { ...note, time, endTime };
  });
}

// Convenience: parse + resolve in one step for a given difficulty.
// Returns notes with absolute `time`/`endTime` plus the tempo map and song meta.
export function buildPlayableTrack(chart, difficulty = "expert") {
  const tempoMap = buildTempoMap(chart.sync, chart.song.resolution);
  const track = chart.tracks[difficulty];
  if (!track) {
    const available = Object.keys(chart.tracks);
    throw new Error(
      `Difficulty "${difficulty}" not in chart (have: ${available.join(", ") || "none"})`
    );
  }
  return {
    song: chart.song,
    tempoMap,
    notes: resolveNoteTimes(track.notes, tempoMap),
    starPower: track.starPower,
    events: chart.events,
  };
}
