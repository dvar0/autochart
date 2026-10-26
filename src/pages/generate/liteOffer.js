// When to offer Fretformer 2 Lite. Lite skips stem separation, the slowest
// step on weak devices, but follows the melody less closely, so it is offered
// only when a device clearly needs it: separation measured well past the
// song's length, or (in the browser) a device that can't separate at all.

import { MODEL_FAMILIES } from "../../data/modelFamilies.js";

export const LITE_FAMILY = MODEL_FAMILIES.find((family) => family.id === "fretformer-2-lite");
export const LITE_GENERATOR_ID = LITE_FAMILY.generatorId;

// Offer Lite when separation is on track to take longer than this many times
// the song's length.
export const SLOW_SEPARATION_RATIO = 2;
// Measure over at least this long after the first segment (which includes
// loading the model) before trusting the estimate.
const MIN_MEASURE_SECONDS = 5;
// Short clips never get the offer: the wait is short either way.
const MIN_OFFER_SECONDS = 60;

// The run's separation clock after a Demucs progress event: when separation
// started, the first finished segment, the latest one, and the audio length.
export function nextSeparationClock(clock, event, now = Date.now()) {
  const progress = Number(event.progress);
  if (!Number.isFinite(progress)) return clock || { startedAt: now };
  const base = clock || { startedAt: now };
  const audioSeconds = Number(event.audioSeconds);
  return {
    ...base,
    audioSeconds: Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : base.audioSeconds || 0,
    firstAt: base.firstAt ?? now,
    firstProgress: base.firstProgress ?? progress,
    lastAt: now,
    lastProgress: progress,
  };
}

// How long the whole separation will take, in seconds, or null while there
// isn't enough to go on. The first segment is left out of the rate: it also
// pays for loading the model.
export function projectedSeparationSeconds(clock) {
  if (!clock?.firstAt || !clock.lastAt) return null;
  const measured = (clock.lastAt - clock.firstAt) / 1000;
  const done = clock.lastProgress - clock.firstProgress;
  if (measured < MIN_MEASURE_SECONDS || done <= 0) return null;
  const rate = done / measured;
  return (clock.lastAt - clock.startedAt) / 1000 + (1 - clock.lastProgress) / rate;
}

// True when this run's separation is slow enough to offer Lite.
export function separationIsSlow(clock) {
  const projected = projectedSeparationSeconds(clock);
  if (projected == null || !clock.audioSeconds) return false;
  return projected >= MIN_OFFER_SECONDS && projected > clock.audioSeconds * SLOW_SEPARATION_RATIO;
}

// Seconds of separation left, from the latest estimate.
export function separationSecondsLeft(clock, now = Date.now()) {
  const projected = projectedSeparationSeconds(clock);
  if (projected == null) return null;
  return Math.max(0, projected - (now - clock.startedAt) / 1000);
}

// "about 12 minutes"
export function minutesText(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// A browser that can't separate in reasonable time before trying: very little
// memory, or a phone or tablet with no graphics card access. Browsers report
// memory in steps (0.25 to 8 GB), so 2 means 2 GB or less.
export function browserNeedsLite(device) {
  if (!device?.checked) return false;
  if (Number.isFinite(device.memoryGb) && device.memoryGb <= 2) return true;
  return Boolean(device.handheld && !device.gpuReachable);
}
