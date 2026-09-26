// Generation settings for Fretformer.
//
// The transcriber replaces the old three-model V1 stack (V24 placement +
// V51 patterns + V42 motif copy) with a single audio-to-sequence model, so
// the controls collapse to what the model actually exposes: a difficulty
// condition (the DIFF prefix token) and sampling (temperature / top-p / seed).
// No decode-time logit surgery by design — if the distribution is wrong, the
// model is wrong.
//
// Fretformer exposes five optional style controls — speed, chords, technique,
// movement, and repetition — plus guidance for controls set away from auto.

import { GENERATOR_LABELS } from "./humanLabels.js";

export const DEFAULT_GENERATOR_ID = "autochart.fretformer.v1-onnx";

// `ends` label the two extremes of the 0..6 bin scale. They describe the bins
// only — "auto" is a separate category (see resolveDescriptorKnobValue) and
// never sits anywhere on this scale.
export const DESCRIPTOR_KNOBS = [
  { id: "speed", key: "knobSpeed", name: "Speed", hint: "notes per second", compact: "Sp", ends: ["sparse", "dense"] },
  { id: "chords", key: "knobChords", name: "Chords", hint: "chord share", compact: "Ch", ends: ["singles", "chords"] },
  { id: "technique", key: "knobTechnique", name: "Technique", hint: "hopos and taps", compact: "Tq", ends: ["plain", "taps"] },
  { id: "movement", key: "knobMovement", name: "Movement", hint: "fret travel", compact: "Mv", ends: ["narrow", "wide"] },
  { id: "repetition", key: "knobRepetition", name: "Repetition", hint: "riff reuse", compact: "Rp", ends: ["varied", "repeats"] },
];

export const DESCRIPTOR_KNOB_MAX = 6;
export const DEFAULT_GUIDANCE_SCALE = 2;

export const DEFAULT_TIMING_SMOOTHING = {
  enabled: true,
  gain: 0.15,
  window: 9,
  bpmRound: 0.5,
};

export const SOURCE_CHART_TIMING_DETECTOR_ID = "source_chart_sync";

const RAW_TIMING_SMOOTHING = {
  ...DEFAULT_TIMING_SMOOTHING,
  enabled: false,
};

export const TIMING_DETECTOR_OPTIONS = [
  {
    id: SOURCE_CHART_TIMING_DETECTOR_ID,
    name: "Imported chart sync",
    shortName: "Source sync",
    detector: "source_chart",
    raw: false,
    sourceChart: true,
    smoothing: RAW_TIMING_SMOOTHING,
  },
  {
    id: "beat_this_custom_timing",
    name: "Automatic timing",
    shortName: "Automatic",
    detector: "beat_this_custom_timing",
    raw: true,
    smoothing: DEFAULT_TIMING_SMOOTHING,
  },
];

export const DEFAULT_TIMING_DETECTOR_ID = "beat_this_custom_timing";

export const TRANSCRIBER_MODEL = {
  label: GENERATOR_LABELS[DEFAULT_GENERATOR_ID],
  shortLabel: GENERATOR_LABELS[DEFAULT_GENERATOR_ID],
  status: "ready",
  description:
    "One model owns timing, placement, fret choice, chords and motif reuse. Conditioned on difficulty.",
};

export const GENERATION_DIFFICULTIES = [
  { id: "easy", name: "Easy", tone: "green" },
  { id: "medium", name: "Medium", tone: "amber" },
  { id: "hard", name: "Hard", tone: "peach" },
  { id: "expert", name: "Expert", tone: "red" },
];

export const GENERATION_PRESETS = [
  {
    id: "tight",
    name: "Tight",
    summary: "Cooler sampling, plays it safe",
    temperature: 0.9,
    topP: 0.95,
  },
  {
    id: "standard",
    name: "Standard",
    summary: "The current eval recipe",
    temperature: 0.95,
    topP: 0.98,
  },
  {
    id: "wild",
    name: "Wild",
    summary: "Hotter sampling, riskier picks",
    temperature: 1,
    topP: 1,
  },
];

export const DEFAULT_GENERATION_CONTROLS = {
  presetId: "standard",
  difficulty: "expert",
  temperature: "0.95",
  topP: "0.98",
  timingDetector: DEFAULT_TIMING_DETECTOR_ID,
  timingSmoothing: true,
  leadInSilenceSeconds: "0",
  seedMode: "random",
  seed: "",
  stripSustains: false,
  knobSpeed: "auto",
  knobChords: "auto",
  knobTechnique: "auto",
  knobMovement: "auto",
  knobRepetition: "auto",
  guidanceScale: "2",
};

export function getTimingDetectorOption(optionId = DEFAULT_TIMING_DETECTOR_ID) {
  return (
    TIMING_DETECTOR_OPTIONS.find((option) => option.id === optionId) ||
    TIMING_DETECTOR_OPTIONS.find((option) => option.id === DEFAULT_TIMING_DETECTOR_ID) ||
    TIMING_DETECTOR_OPTIONS[0]
  );
}

export function timingDetectorOptionFromResolved(resolved = {}) {
  const explicit = resolved.timingDetector || resolved.timingDetectorId;
  if (explicit && TIMING_DETECTOR_OPTIONS.some((option) => option.id === explicit)) return explicit;

  const detector = String(resolved.detector || "").trim();
  if (detector === "source_chart") return SOURCE_CHART_TIMING_DETECTOR_ID;
  const raw = Boolean(resolved.timingRaw);
  const matched = TIMING_DETECTOR_OPTIONS.find((option) => option.detector === detector && option.raw === raw);
  return matched?.id || DEFAULT_TIMING_DETECTOR_ID;
}

export function timingDetectorLabel(optionId = DEFAULT_TIMING_DETECTOR_ID, { short = false } = {}) {
  const option = getTimingDetectorOption(optionId);
  return short ? option.shortName : option.name;
}

function booleanSetting(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function timingSmoothingEnabledFromGeneration(generation = {}) {
  const controls = generation?.controls || {};
  const resolved = generation?.resolved || {};
  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  const timingOption = getTimingDetectorOption(timingDetector);
  if (timingOption.sourceChart) return false;
  return booleanSetting(
    resolved.timingSmoothing?.enabled ?? controls.timingSmoothing,
    timingOption.smoothing?.enabled ?? DEFAULT_TIMING_SMOOTHING.enabled
  );
}

export function getGenerationPreset(presetId) {
  return (
    GENERATION_PRESETS.find((preset) => preset.id === presetId) ||
    GENERATION_PRESETS.find((preset) => preset.id === "standard") ||
    GENERATION_PRESETS[0]
  );
}

export function getGenerationDifficulty(difficulty) {
  return (
    GENERATION_DIFFICULTIES.find((option) => option.id === difficulty) ||
    GENERATION_DIFFICULTIES[GENERATION_DIFFICULTIES.length - 1]
  );
}

export function controlsForGenerationPreset(presetId, current = DEFAULT_GENERATION_CONTROLS) {
  const preset = getGenerationPreset(presetId);
  return {
    ...current,
    presetId: preset.id,
    temperature: preset.temperature.toFixed(2),
    topP: preset.topP.toFixed(2),
  };
}

export function normalizeGenerationSeed(controls = DEFAULT_GENERATION_CONTROLS) {
  if (controls.seedMode !== "fixed") return null;
  const seed = Number.parseInt(String(controls.seed ?? "").trim(), 10);
  return Number.isFinite(seed) ? seed : null;
}

export function normalizeLeadInSilenceSeconds(value) {
  const seconds = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(30, Math.round(seconds * 1000) / 1000);
}

// A knob control is "auto" (model decides) or an integer bin 0..DESC.
// `null` means unset/auto for the resolved shape the engine consumes.
function resolveDescriptorKnobValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === "" || text === "auto") return null;
  const num = Number.parseInt(text, 10);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(DESCRIPTOR_KNOB_MAX, Math.trunc(num)));
}

function resolveGuidanceScaleValue(value) {
  const num = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(num)) return DEFAULT_GUIDANCE_SCALE;
  return Math.max(1, Math.min(8, num));
}

function resolveDescriptorKnobs(controls = {}) {
  const knobs = {};
  for (const knob of DESCRIPTOR_KNOBS) {
    knobs[knob.id] = resolveDescriptorKnobValue(controls[knob.key]);
  }
  return knobs;
}

// Saved generations store the resolved null-or-int shape under
// generation.controls.knobs (a {speed, chords, ...} map) plus a numeric
// guidanceScale. Older projects lack both; fall back to the explicit string
// control keys if present, otherwise the "auto"/default form the UI expects.
function savedKnobControl(resolvedKnob, explicitValue) {
  if (resolvedKnob != null) return String(resolvedKnob);
  if (explicitValue != null && String(explicitValue).trim() !== "") return String(explicitValue);
  return "auto";
}

export function controlsFromSavedGeneration(
  generation,
  fallbackDifficulty = "expert",
  { fallbackTimingDetector = DEFAULT_TIMING_DETECTOR_ID } = {}
) {
  const controls = generation?.controls || {};
  const resolved = generation?.resolved || {};
  const preset = getGenerationPreset(generation?.presetId || controls.presetId);
  const seed = controls.seed ?? generation?.seed ?? null;
  const temperature = controls.temperature ?? resolved.temperature;
  const topP = controls.topP ?? resolved.topP;
  // Only a saved run carries a detector choice; without one the project default
  // applies, which is the imported sync track when the project has one.
  const savedTimingDetector = controls.timingDetector
    || (resolved.timingDetector || resolved.timingDetectorId || resolved.detector
      ? timingDetectorOptionFromResolved(resolved)
      : "");
  const timingDetector = savedTimingDetector || fallbackTimingDetector;
  const savedKnobs = plainSavedKnobs(controls.knobs);
  return {
    ...DEFAULT_GENERATION_CONTROLS,
    presetId: preset.id,
    difficulty: getGenerationDifficulty(controls.difficulty || fallbackDifficulty).id,
    temperature: temperature == null ? preset.temperature.toFixed(2) : String(temperature),
    topP: topP == null ? preset.topP.toFixed(2) : String(topP),
    timingDetector,
    timingSmoothing: timingSmoothingEnabledFromGeneration({ controls, resolved }),
    leadInSilenceSeconds: String(
      normalizeLeadInSilenceSeconds(
        controls.leadInSilenceSeconds ?? resolved.leadInSilenceSeconds ?? generation?.sourceTransform?.leadInSilenceSeconds
      )
    ),
    seedMode: controls.seedMode === "fixed" || seed != null ? "fixed" : "random",
    seed: seed == null ? "" : String(seed),
    stripSustains: Boolean(
      controls.stripSustains ?? resolved.stripSustains ?? DEFAULT_GENERATION_CONTROLS.stripSustains
    ),
    knobSpeed: savedKnobControl(savedKnobs.speed, controls.knobSpeed),
    knobChords: savedKnobControl(savedKnobs.chords, controls.knobChords),
    knobTechnique: savedKnobControl(savedKnobs.technique, controls.knobTechnique),
    knobMovement: savedKnobControl(savedKnobs.movement, controls.knobMovement),
    knobRepetition: savedKnobControl(savedKnobs.repetition, controls.knobRepetition),
    guidanceScale:
      controls.guidanceScale != null
        ? String(controls.guidanceScale)
        : resolved.guidanceScale != null
          ? String(resolved.guidanceScale)
          : DEFAULT_GENERATION_CONTROLS.guidanceScale,
  };
}

function plainSavedKnobs(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function resolveGenerationSettings(controls = DEFAULT_GENERATION_CONTROLS, generator = null) {
  const preset = getGenerationPreset(controls.presetId);
  const timingOption = getTimingDetectorOption(controls.timingDetector);
  const temperature = Number.parseFloat(String(controls.temperature ?? "").trim());
  const topP = Number.parseFloat(String(controls.topP ?? "").trim());
  const sourceChartTiming = Boolean(timingOption.sourceChart);
  const leadInSilenceSeconds = sourceChartTiming ? 0 : normalizeLeadInSilenceSeconds(controls.leadInSilenceSeconds);
  const timingSmoothingDefaults = {
    ...DEFAULT_TIMING_SMOOTHING,
    ...(timingOption.smoothing || {}),
    ...(generator?.timing?.smoothing || {}),
  };
  const timingSmoothing = sourceChartTiming
    ? RAW_TIMING_SMOOTHING
    : {
        ...timingSmoothingDefaults,
        enabled: booleanSetting(controls.timingSmoothing, timingSmoothingDefaults.enabled),
      };
  const knobs = resolveDescriptorKnobs(controls);
  const knobsActive = DESCRIPTOR_KNOBS.some((knob) => knobs[knob.id] != null);
  const guidanceScale = resolveGuidanceScaleValue(controls.guidanceScale);
  // Sustains are a hard project rule for "never-strip" generators (e.g. the
  // ONNX Fretformer): the UI hides the toggle and the resolved value is forced
  // off so a stale stored control can never reach the engine.
  const sustainsPolicy = generator?.capabilities?.sustains;
  const sustainsLockedOff = sustainsPolicy === "never-strip";
  return {
    difficulty: getGenerationDifficulty(controls.difficulty).id,
    temperature: Number.isFinite(temperature) ? temperature : preset.temperature,
    topP: Number.isFinite(topP) ? topP : preset.topP,
    stripSustains: sustainsLockedOff ? false : Boolean(controls.stripSustains),
    sustainsLockedOff,
    timingDetector: timingOption.id,
    detector: timingOption.detector,
    timingRaw: timingOption.raw,
    bpmTolerance: 0,
    timingSmoothing,
    leadInSilenceSeconds,
    leadInSilenceMs: Math.round(leadInSilenceSeconds * 1000),
    seed: normalizeGenerationSeed(controls),
    knobs,
    knobsActive,
    guidanceScale,
  };
}

export function isGenerationModified(
  controls = DEFAULT_GENERATION_CONTROLS,
  generator = null,
  { defaultTimingDetector = DEFAULT_TIMING_DETECTOR_ID } = {}
) {
  const preset = getGenerationPreset(controls.presetId);
  const resolved = resolveGenerationSettings(controls, generator);
  const seed = normalizeGenerationSeed(controls);
  const defaultSeed = normalizeGenerationSeed(DEFAULT_GENERATION_CONTROLS);
  // Imported chart sync fixes smoothing off, so it is not a user change there.
  const smoothingDefault = resolved.timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID
    ? false
    : DEFAULT_GENERATION_CONTROLS.timingSmoothing;
  return (
    Math.abs(resolved.temperature - preset.temperature) > 0.000001 ||
    Math.abs(resolved.topP - preset.topP) > 0.000001 ||
    resolved.stripSustains !== DEFAULT_GENERATION_CONTROLS.stripSustains ||
    resolved.timingDetector !== defaultTimingDetector ||
    resolved.timingSmoothing.enabled !== smoothingDefault ||
    resolved.leadInSilenceMs !== 0 ||
    controls.seedMode !== DEFAULT_GENERATION_CONTROLS.seedMode ||
    seed !== defaultSeed ||
    resolved.knobsActive
  );
}

export function buildGenerationSettings({
  generatorId = DEFAULT_GENERATOR_ID,
  controls = DEFAULT_GENERATION_CONTROLS,
  generator = null,
  defaultTimingDetector = DEFAULT_TIMING_DETECTOR_ID,
} = {}) {
  const preset = getGenerationPreset(controls.presetId);
  const resolved = resolveGenerationSettings(controls, generator);
  return {
    difficulty: resolved.difficulty,
    generation: {
      generatorId,
      presetId: preset.id,
      presetName: preset.name,
      modified: isGenerationModified(controls, generator, { defaultTimingDetector }),
      controls: {
        difficulty: resolved.difficulty,
        temperature: resolved.temperature,
        topP: resolved.topP,
        timingDetector: resolved.timingDetector,
        timingSmoothing: resolved.timingSmoothing.enabled,
        leadInSilenceSeconds: resolved.leadInSilenceSeconds,
        seedMode: resolved.seed == null ? "random" : "fixed",
        seed: resolved.seed,
        stripSustains: resolved.stripSustains,
        knobs: resolved.knobs,
        guidanceScale: resolved.guidanceScale,
      },
      resolved,
    },
  };
}

function formatSettingNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "");
}

function settingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function changedFromPreset(value, presetValue) {
  const number = settingNumber(value);
  const presetNumber = settingNumber(presetValue);
  if (number == null || presetNumber == null) return false;
  return Math.abs(number - presetNumber) > 0.000001;
}

function generationDisplayParts(generation, { compact = false } = {}) {
  if (!generation) return [];
  const controls = generation.controls || {};
  const resolved = generation.resolved || {};
  const preset = getGenerationPreset(generation.presetId || controls.presetId);
  const difficulty = controls.difficulty || resolved.difficulty;
  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  const parts = [];
  if (difficulty) parts.push(getGenerationDifficulty(difficulty).name);
  if (generation.presetName !== "Standard" || preset.id !== "standard") {
    parts.push(generation.presetName || preset.name);
  }
  if (timingDetector !== DEFAULT_TIMING_DETECTOR_ID) {
    parts.push(timingDetectorLabel(timingDetector, { short: compact }));
  }
  if (timingDetector !== SOURCE_CHART_TIMING_DETECTOR_ID && !timingSmoothingEnabledFromGeneration(generation)) {
    parts.push(compact ? "RawGrid" : "Raw timing");
  }
  const temperature = resolved.temperature ?? controls.temperature;
  const topP = resolved.topP ?? controls.topP;
  const fixedSeed = controls.seedMode === "fixed" && controls.seed != null ? controls.seed : null;
  if (changedFromPreset(temperature, preset.temperature)) {
    parts.push(`${compact ? "T" : "Temp "}${formatSettingNumber(temperature)}`);
  }
  if (changedFromPreset(topP, preset.topP)) {
    parts.push(`${compact ? "P" : "Top-p "}${formatSettingNumber(topP)}`);
  }
  const knobValues = controls.knobs ?? resolved.knobs ?? {};
  for (const knob of DESCRIPTOR_KNOBS) {
    const value = knobValues[knob.id];
    if (value == null) continue;
    parts.push(compact ? `${knob.compact}${value}` : `${knob.name} ${value}`);
  }
  const knobsActiveHere = DESCRIPTOR_KNOBS.some((knob) => knobValues[knob.id] != null);
  const knobGuidance =
    resolved.guidanceScale != null ? Number(resolved.guidanceScale) : Number(controls.guidanceScale);
  if (knobsActiveHere && Number.isFinite(knobGuidance) && knobGuidance > 1) {
    parts.push(compact ? `CFG${formatSettingNumber(knobGuidance)}` : `Guidance ${formatSettingNumber(knobGuidance)}`);
  }
  if (controls.stripSustains ?? resolved.stripSustains) {
    parts.push(compact ? "NoSus" : "No sustains");
  }
  if (fixedSeed != null) {
    parts.push(`${compact ? "S" : "Seed "}${fixedSeed}`);
  }
  return parts.filter(Boolean);
}

export function generationVersionName(generatorLabel = TRANSCRIBER_MODEL.shortLabel, generation, index = 1) {
  const parts = generationDisplayParts(generation, { compact: true });
  return [generatorLabel, ...parts, `#${index}`].filter(Boolean).join(" ");
}

export function generationSummary(settings, generatorLabel = TRANSCRIBER_MODEL.shortLabel) {
  const generation = settings?.generation || {};
  const controls = generation.controls || {};
  const resolvedSeed = generation.resolved?.seed;
  const parts = generationDisplayParts(generation);
  const seed =
    controls.seedMode === "fixed" && controls.seed != null
      ? null
      : resolvedSeed != null
        ? `Seed ${resolvedSeed}`
        : "Seed random";
  return [generatorLabel, ...parts, seed].filter(Boolean).join(" · ");
}
