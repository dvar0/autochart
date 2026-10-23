// Generation settings as the engine runs them: the UI's generation payload
// (presets, controls, resolved values) normalized into transcriber settings,
// and the effective generation recorded with each take. Shared by the desktop
// engine (engine/bin) and the browser engine (engine/web), so a take made in
// either one reproduces the same way.

export const DEFAULT_TRANSCRIBER_SETTINGS = {
  timingDetector: "beat_this_custom_timing",
  detector: "beat_this_custom_timing",
  timingRaw: true,
  bpmTolerance: 0,
  difficulty: "expert",
  temperature: 0.95,
  topP: 0.98,
  stripSustains: false,
  seed: 20260609,
  smoothing: {
    enabled: true,
    method: "line-fit",
    bpmRound: 0.5,
  },
};
export const SOURCE_CHART_DETECTOR = "source_chart";
export const SOURCE_CHART_TIMING_DETECTOR = "source_chart_sync";
// v1's knobs. Generators with another knob set list it in
// capabilities.descriptorKnobs; the model manifest's vocab must agree.
export const DESCRIPTOR_KNOB_NAMES = ["speed", "chords", "technique", "movement", "repetition"];
export const DESCRIPTOR_KNOB_MAX = 6;
export const DEFAULT_GUIDANCE_SCALE = 2;

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function textValue(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function numberValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function integerValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

export function booleanValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

// A random seed in the decoder's range (1..2^31-2).
function randomSeedValue() {
  const [value] = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return 1 + (value % (2 ** 31 - 2));
}

export function normalizeDifficulty(value, fallback = DEFAULT_TRANSCRIBER_SETTINGS.difficulty) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["easy", "medium", "hard", "expert"].includes(text) ? text : fallback;
}

// Descriptor knobs: null/"auto" or integer bin 0..6 in resolved.knobs or controls.knobs.
export function resolveDescriptorKnob(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === "" || text === "auto") return null;
  const num = Number.parseInt(text, 10);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(DESCRIPTOR_KNOB_MAX, Math.trunc(num)));
}

export function descriptorKnobNames(generator) {
  const knobs = generator?.capabilities?.descriptorKnobs;
  return Array.isArray(knobs) && knobs.length ? knobs.map(String) : DESCRIPTOR_KNOB_NAMES;
}

function resolveDescriptorKnobsFrom(generation, knobNames = DESCRIPTOR_KNOB_NAMES) {
  const resolved = plainObject(generation.resolved);
  const controls = plainObject(generation.controls);
  const resolvedKnobs = plainObject(resolved.knobs);
  const controlKnobs = plainObject(controls.knobs);
  const knobs = {};
  for (const name of knobNames) {
    knobs[name] = resolveDescriptorKnob(resolvedKnobs[name] ?? controlKnobs[name]);
  }
  return knobs;
}

export function normalizeTranscriberSettings(job, generator) {
  const generation = plainObject(job.generation);
  const controls = plainObject(generation.controls);
  const resolved = plainObject(generation.resolved);
  const timing = plainObject(generator.timing);
  const smoothingDefaults = {
    ...DEFAULT_TRANSCRIBER_SETTINGS.smoothing,
    ...plainObject(timing.smoothing),
  };
  const smoothing = plainObject(resolved.timingSmoothing ?? job.timingSmoothing);
  const smoothingEnabled = smoothing.enabled ?? controls.timingSmoothing ?? job.timingSmoothingEnabled;
  const randomSeed = controls.seedMode === "random";
  const requestedTimingDetector = textValue(
    resolved.timingDetector ?? controls.timingDetector ?? job.timingDetector,
    DEFAULT_TRANSCRIBER_SETTINGS.timingDetector
  );
  const detectorIn = textValue(resolved.detector ?? timing.detector ?? job.detector, DEFAULT_TRANSCRIBER_SETTINGS.detector);
  const usesSourceChartTiming = requestedTimingDetector === SOURCE_CHART_TIMING_DETECTOR || detectorIn === SOURCE_CHART_DETECTOR;
  const detector = usesSourceChartTiming ? SOURCE_CHART_DETECTOR : detectorIn;
  const timingRaw = booleanValue(
    usesSourceChartTiming ? false : resolved.timingRaw ?? job.timingRaw ?? timing.raw,
    DEFAULT_TRANSCRIBER_SETTINGS.timingRaw
  );
  const seed = integerValue(
    resolved.seed ?? controls.seed ?? job.seed,
    randomSeed ? randomSeedValue() : DEFAULT_TRANSCRIBER_SETTINGS.seed,
    { min: 0, max: 2 ** 31 - 2 }
  );

  const knobNames = descriptorKnobNames(generator);
  const knobs = resolveDescriptorKnobsFrom(generation, knobNames);
  const knobsActive = knobNames.some((name) => knobs[name] != null);
  const guidanceScale = numberValue(
    resolved.guidanceScale ?? controls.guidanceScale ?? job.guidanceScale,
    DEFAULT_GUIDANCE_SCALE,
    { min: 1, max: 8 }
  );

  return {
    timingDetector: usesSourceChartTiming
      ? SOURCE_CHART_TIMING_DETECTOR
      : textValue(
          requestedTimingDetector,
          timingRaw && detector === "beat_this_custom_timing" ? "beat_this_custom_timing" : DEFAULT_TRANSCRIBER_SETTINGS.timingDetector
        ),
    detector,
    timingRaw,
    bpmTolerance: numberValue(
      resolved.bpmTolerance ?? timing.bpmTolerance ?? job.bpmTolerance,
      DEFAULT_TRANSCRIBER_SETTINGS.bpmTolerance,
      { min: 0 }
    ),
    difficulty: normalizeDifficulty(resolved.difficulty ?? controls.difficulty ?? job.difficulty),
    temperature: numberValue(
      resolved.temperature ?? controls.temperature ?? job.temperature,
      DEFAULT_TRANSCRIBER_SETTINGS.temperature,
      { min: 0.05, max: 2 }
    ),
    topP: numberValue(resolved.topP ?? controls.topP ?? job.topP, DEFAULT_TRANSCRIBER_SETTINGS.topP, {
      min: 0.01,
      max: 1,
    }),
    stripSustains: booleanValue(
      resolved.stripSustains ?? controls.stripSustains ?? job.stripSustains,
      DEFAULT_TRANSCRIBER_SETTINGS.stripSustains
    ),
    seed,
    smoothing: {
      enabled: usesSourceChartTiming ? false : booleanValue(smoothingEnabled, smoothingDefaults.enabled),
      method: DEFAULT_TRANSCRIBER_SETTINGS.smoothing.method,
      bpmRound: numberValue(smoothing.bpmRound, smoothingDefaults.bpmRound, { min: 0.001 }),
    },
    knobs,
    knobsActive,
    guidanceScale,
    // Structure-marker models only: false asks for no solo markers; forceSolo
    // re-charts from the likeliest solo start when none was sampled.
    solos: booleanValue(resolved.solos ?? controls.solos ?? job.solos, true),
    forceSolo: booleanValue(resolved.forceSolo ?? controls.forceSolo ?? job.forceSolo, false),
  };
}

export function effectiveTranscriberGeneration(job, settings) {
  const generation = plainObject(job.generation);
  const controls = plainObject(generation.controls);
  const fixedSeed = controls.seedMode !== "random";
  return {
    generatorId: job.generatorId,
    presetId: textValue(generation.presetId, "standard"),
    presetName: textValue(generation.presetName, "Standard"),
    modified: Boolean(generation.modified),
    controls: {
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      topP: settings.topP,
      timingDetector: settings.timingDetector,
      timingSmoothing: settings.smoothing.enabled,
      seedMode: fixedSeed ? "fixed" : "random",
      seed: fixedSeed ? settings.seed : null,
      stripSustains: settings.stripSustains,
      knobs: settings.knobs,
      guidanceScale: settings.guidanceScale,
    },
    resolved: {
      ...(plainObject(generation.resolved)),
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      topP: settings.topP,
      stripSustains: settings.stripSustains,
      detector: settings.detector,
      timingDetector: settings.timingDetector,
      timingRaw: settings.timingRaw,
      bpmTolerance: settings.bpmTolerance,
      seed: settings.seed,
      timingSmoothing: settings.smoothing,
      knobs: settings.knobs,
      guidanceScale: settings.guidanceScale,
    },
  };
}
