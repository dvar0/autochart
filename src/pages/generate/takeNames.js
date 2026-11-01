import { GENERATOR_LABELS } from "../../data/humanLabels.js";
import { DEFAULT_GENERATOR_ID, generationVersionName } from "../../data/generationSettings.js";
import { t } from "../../i18n/index.js";

// The first model is "Fretformer 1" wherever a person reads it; older takes
// stored its label as plain "Fretformer".
function displayModel(label) {
  return label === "Fretformer" ? "Fretformer 1" : label;
}

// The model a take came from. Edited drafts carry "Edited" as their model
// label, so they fall back to the generator they were made with.
export function modelName(version, generators = []) {
  const label = String(version?.settings?.model || "").trim();
  if (label && label !== "Edited") return displayModel(label);
  const generatorId = version?.meta?.generatorId || version?.settings?.generation?.generatorId || "";
  const generator = generators.find((item) => item.id === generatorId);
  if (generator?.label) return displayModel(generator.label);
  if (GENERATOR_LABELS[generatorId]) return displayModel(GENERATOR_LABELS[generatorId]);
  if (generatorId === DEFAULT_GENERATOR_ID) return "Fretformer 1";
  return generatorId.split(".").pop()?.toUpperCase() || "";
}

// What a take is called on its card and on the stage. The stored name also
// lists the difficulty, the sampling, the seed and the number, all of which
// have their own place next to it. Takes from elsewhere keep their name.
// Charts the app didn't write. Imported takes can carry the project's
// generation settings, so the source decides, not the settings.
function madeElsewhere(version) {
  return version?.source === "imported-chart" || !version?.settings?.generation;
}

export function takeTitle(version, generators = []) {
  const name = String(version?.name || "");
  // Names the app gave charts it didn't write show in the current language.
  if (madeElsewhere(version)) return IMPORTED_NAMES[name]?.() || name;
  const model = modelName(version, generators);
  if (!model) return name;
  const edit = name.match(/\bEdit (\d+)$/i);
  return edit ? t("{model} · Edit {number}", { model, number: edit[1] }) : model;
}

// A take's number, the one in its stored name, so a removed take doesn't
// renumber the rest. Older names without one fall back to their place.
export function takeNumber(version, index) {
  const match = String(version?.name || "").match(/#(\d+)/);
  return match ? match[1] : String(index);
}

// A take card's heading. Generated takes store a name like "Fretformer 2
// Expert #5" (and edits add " Edit 1") in whatever language was on when they
// were made; it's rebuilt from the take's settings so it reads in the current
// language. Other names show as they are.
export function takeCardName(version, generators = []) {
  const name = String(version?.name || "");
  const edit = name.match(/^(.*?)\s+Edit\s+(\d+)$/i);
  const base = edit ? edit[1] : name;
  const generation = version?.settings?.generation;
  const number = base.match(/#(\d+)$/);
  const shown = madeElsewhere(version)
    ? IMPORTED_NAMES[base]?.() || base
    : number
      ? generationVersionName(modelName(version, generators) || base.replace(/\s.*$/, ""), generation, number[1])
      : base;
  return edit ? t("{name} Edit {number}", { name: shown, number: edit[2] }) : shown;
}

// Names the app gives charts it didn't write; saved in English.
const IMPORTED_NAMES = {
  "Imported Clone Hero": () => t("Imported Clone Hero"),
  "Edited outside Autochart": () => t("Edited outside Autochart"),
};
