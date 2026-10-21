"use strict";

// "Force a solo" for structure-marker models (Fretformer v2 DPO). Port of the
// training repo's --require-solo (scripts/generate_chart_transcriber_song.py:
// marker_observer, force_marker_at_best, force_solo_passes); its parity gate
// is scripts/check_fretformer_v1_2_app_parity.py.
//
// 1. Chart the song normally, recording P(SOLO_START) wherever a solo could
//    start (after a BEAT, a section or a solo end).
// 2. If no solo was sampled, keep the stream up to the most likely start,
//    insert SOLO_START there and chart the rest, recording P(SOLO_END) after
//    each BEAT at least 8 beats into the solo.
// 3. If that solo never ends, insert SOLO_END where P(end) peaked and chart
//    the rest again.
// Each re-chart resumes from the previous pass's self-attention cache, cut to
// the kept tokens, instead of re-feeding them (if cutting fails it re-feeds
// them), and restarts the sampler from the same seed, as the reference
// re-runs generate with the same seed.

const { BEAT_TOKEN, decodeStructure } = require("./chartEventStream.cjs");
const { generate, makeRng, sliceCache, disposeCache } = require("./transcribe.cjs");

// Returns { probs, observe }: probs maps beat -> { p, pos }, the highest
// P(marker) seen at that beat and the stream position to insert it at.
function markerObserver(marker, minBeat, temperature, structure) {
  const soloStart = Number(structure.SOLO_START_TOKEN);
  const soloEnd = Number(structure.SOLO_END_TOKEN);
  const sectionBase = Number(structure.SECTION_BASE);
  const sectionEnd = sectionBase + (structure.SECTION_TYPES || []).length;
  const t = temperature > 0 ? temperature : 1;
  const probs = new Map();
  let seen = 0;
  let beats = 0;
  function observe(tokens, logits) {
    for (let i = seen; i < tokens.length; i += 1) if (tokens[i] === BEAT_TOKEN) beats += 1;
    seen = tokens.length;
    const last = tokens[tokens.length - 1];
    const legal = marker === soloStart
      ? last === BEAT_TOKEN || last === soloEnd || (sectionBase <= last && last < sectionEnd)
      : last === BEAT_TOKEN;
    const beat = beats - 1;
    if (!legal || beat < minBeat) return;
    let max = -Infinity;
    for (let i = 0; i < logits.length; i += 1) if (logits[i] / t > max) max = logits[i] / t;
    let sum = 0;
    for (let i = 0; i < logits.length; i += 1) sum += Math.exp(logits[i] / t - max);
    const p = Math.exp(logits[marker] / t - max) / sum;
    const prev = probs.get(beat);
    if (!prev || p > prev.p) probs.set(beat, { p, pos: tokens.length });
  }
  return { probs, observe };
}

// The first beat with the highest p (Python's max over beats in seen order).
function bestBeat(probs) {
  let best = null;
  for (const [beat, entry] of probs) if (!best || entry.p > best.entry.p) best = { beat, entry };
  return best;
}

function countSolos(tokens, structure) {
  return decodeStructure(tokens, structure).solos;
}

// options: the generate() options for the normal decode (prefixTokens,
// uncondPrefixTokens, rng, onProgress, ...). seed re-creates the sampler for
// each re-chart. Returns { result, forcedSolo } where forcedSolo is null when
// the first pass already had a solo (or nowhere to put one).
async function generateWithForcedSolo(options, { structure, seed, log = null }) {
  const soloStart = Number(structure.SOLO_START_TOKEN);
  const soloEnd = Number(structure.SOLO_END_TOKEN);
  const { temperature, onProgress } = options;
  const prefixLen = options.prefixTokens.length;
  // A pass's final progress event is only final if no re-chart follows.
  let heldDone = null;
  const progress = onProgress
    ? (event) => {
        if (event.done) heldDone = event;
        else onProgress(event);
      }
    : null;
  const started = Date.now();
  let passes = 0;
  const finish = (result, forcedSolo) => {
    disposeCache(result.cache);
    delete result.cache;
    // Decode time and passes over the whole procedure, not just the last pass.
    result.stats = { ...result.stats, generationSeconds: Math.round((Date.now() - started) / 10) / 100, passes };
    if (onProgress && heldDone) onProgress(heldDone);
    return { result, forcedSolo };
  };

  const rechart = async (previous, probs, marker, observe, keepCache) => {
    const { beat, entry } = bestBeat(probs);
    const tokens = Array.from(previous.tokens);
    const prefixTokens = tokens.slice(0, entry.pos).concat([marker]);
    const uncondPrefixTokens = options.uncondPrefixTokens
      ? options.uncondPrefixTokens.concat(prefixTokens.slice(prefixLen))
      : options.uncondPrefixTokens;
    let initialCache = null;
    try {
      initialCache = await sliceCache(previous.cache, entry.pos);
    } catch (error) {
      if (log) log(`force-solo: could not reuse the decoder cache (${error && error.message}); re-feeding ${entry.pos} tokens`);
    } finally {
      disposeCache(previous.cache);
      delete previous.cache;
    }
    heldDone = null;
    passes += 1;
    try {
      const result = await generate({
        ...options,
        prefixTokens,
        uncondPrefixTokens,
        rng: options.rng ? makeRng(seed) : options.rng,
        initialCache,
        onLogits: observe,
        returnCache: keepCache,
        onProgress: progress,
      });
      return { result, info: { beat, p: Math.round(entry.p * 1e5) / 1e5 } };
    } catch (error) {
      disposeCache(initialCache);
      throw error;
    }
  };

  const start = markerObserver(soloStart, 0, temperature, structure);
  passes += 1;
  const first = await generate({ ...options, onLogits: start.observe, returnCache: true, onProgress: progress });
  if (countSolos(first.tokens, structure).length || !start.probs.size) return finish(first, null);

  const startBeat = bestBeat(start.probs).beat;
  const end = markerObserver(soloEnd, startBeat + 8, temperature, structure);
  const second = await rechart(first, start.probs, soloStart, end.observe, true);
  const forcedSolo = { start: second.info, end: null };
  if (log) log(`force-solo: none sampled; forced start at beat ${second.info.beat} (p=${second.info.p.toFixed(4)})`);
  const solos = countSolos(second.result.tokens, structure);
  if (!(solos.length && solos[0][1] === null && end.probs.size)) return finish(second.result, forcedSolo);

  const third = await rechart(second.result, end.probs, soloEnd, null, false);
  forcedSolo.end = third.info;
  if (log) log(`force-solo: forced solo end at beat ${third.info.beat} (p=${third.info.p.toFixed(4)})`);
  return finish(third.result, forcedSolo);
}

module.exports = { generateWithForcedSolo, markerObserver };
