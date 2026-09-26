// Derives per-note gameplay flags the renderer needs but the raw chart doesn't
// store explicitly: HOPO vs strum vs tap, and whether a note falls inside a
// star-power phrase. Kept separate from parsing/timing so it can run at preview
// time on any resolved track (fresh import or one rehydrated from storage),
// regardless of how the track was persisted.

// Clone Hero's default auto-HOPO distance: 65 ticks at the 192 standard
// resolution (scaled for other resolutions). Notes closer than this to the
// previous note become HOPOs unless overridden.
const HOPO_TICKS_AT_192 = 65;

// Annotates each note (in place) with `hopo` (bool) and `kind`
// ("strum" | "hopo" | "tap"). Notes must be tick-sorted.
//
// Natural HOPO rules (then `force` inverts, `tap` overrides):
//   - chords and open notes are never natural HOPOs
//   - a single note within the threshold of the previous note is a HOPO,
//     UNLESS it repeats the previous note's single fret (anti-repeat rule)
export function annotateNotes(notes, resolution = 192) {
  const threshold = (resolution / 192) * HOPO_TICKS_AT_192;
  let prev = null;
  for (const note of notes) {
    let hopo = false;
    if (!note.open && note.frets.length === 1 && prev) {
      const gap = note.tick - prev.tick;
      const sameFret = prev.frets.length === 1 && prev.frets[0] === note.frets[0];
      if (gap > 0 && gap <= threshold && !sameFret) hopo = true;
    }
    if (note.force) hopo = !hopo; // forced flag toggles natural strum/HOPO
    if (note.tap) hopo = false; // taps are their own kind, never HOPO
    note.hopo = hopo;
    note.kind = note.tap ? "tap" : hopo ? "hopo" : "strum";
    prev = note;
  }
  return notes;
}

// Resolves star-power phrases (kind 2) to absolute-second ranges, sorted.
export function resolveStarPhrases(starPower, tempoMap) {
  if (!starPower || !tempoMap) return [];
  return starPower
    .filter((s) => s.kind === 2)
    .map((s) => ({
      start: tempoMap.tickToSeconds(s.tick),
      end: tempoMap.tickToSeconds(s.tick + s.length),
    }))
    .sort((a, b) => a.start - b.start);
}

// Marks each note (in place) with `star` = inside a star-power phrase.
// Notes must be time-sorted; phrases must be start-sorted.
export function markStarNotes(notes, phrases) {
  let pi = 0;
  for (const note of notes) {
    while (pi < phrases.length && phrases[pi].end <= note.time) pi++;
    note.star =
      pi < phrases.length &&
      note.time >= phrases[pi].start &&
      note.time < phrases[pi].end;
  }
  return notes;
}

function makeLyricPhrase(start, end, words) {
  if (!words.length) return null;
  const phraseStart = Number.isFinite(start) ? start : words[0].time;
  const lastWordTime = words[words.length - 1].time;
  const phraseEnd = Number.isFinite(end)
    ? Math.max(end, lastWordTime + 0.35)
    : lastWordTime + 1.4;

  let line = "";
  const displayWords = words.map((word) => {
    const sep = line && !line.endsWith("-") ? " " : "";
    const prefix = line + sep;
    line = prefix + word.text;
    return { ...word, prefix };
  });

  return {
    start: phraseStart,
    end: phraseEnd,
    text: line,
    words: displayWords,
  };
}

function lyricText(rawText) {
  const text = String(rawText || "").trim();
  const m = text.match(/^lyric(?:\s+(.+))?$/i);
  if (!m) return null;
  const lyric = (m[1] || "").trim();
  return lyric || null;
}

// Resolves Clone Hero `.chart` global lyric events to timed display phrases.
// Expected event text is `phrase_start`, `phrase_end`, and `lyric <token>`.
// If phrase markers are absent or incomplete, lyric tokens still form phrases.
export function resolveLyricPhrases(events, tempoMap) {
  if (!events || !tempoMap) return [];

  const phrases = [];
  let current = null;

  const flush = (endTime = null) => {
    if (!current) return;
    const phrase = makeLyricPhrase(current.start, endTime, current.words);
    if (phrase) phrases.push(phrase);
    current = null;
  };

  for (const event of events) {
    const raw = String(event.text || "").trim();
    const lower = raw.toLowerCase();
    const time = tempoMap.tickToSeconds(event.tick);

    if (lower === "phrase_start") {
      flush(time);
      current = { start: time, words: [] };
      continue;
    }

    if (lower === "phrase_end") {
      flush(time);
      continue;
    }

    const text = lyricText(raw);
    if (!text) continue;
    if (!current) current = { start: time, words: [] };
    current.words.push({ tick: event.tick, time, text });
  }

  flush();
  return phrases.sort((a, b) => a.start - b.start);
}

export function activeLyricPhrase(phrases, songTime, { lead = 0.55, tail = 0.7 } = {}) {
  if (!phrases?.length || !Number.isFinite(songTime)) return null;
  let best = null;
  for (const phrase of phrases) {
    if (phrase.start > songTime + lead) break;
    if (songTime >= phrase.start - lead && songTime <= phrase.end + tail) {
      best = phrase;
    }
  }
  if (!best) return null;

  let currentWordIndex = -1;
  for (let i = 0; i < (best.words || []).length; i++) {
    if (best.words[i].time <= songTime + 0.03) currentWordIndex = i;
    else break;
  }
  return { ...best, currentWordIndex };
}
