import { GENERATOR_LABELS } from "../../data/humanLabels.js";
import { DEFAULT_GENERATOR_ID } from "../../data/generationSettings.js";

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
export function takeTitle(version, generators = []) {
  const name = String(version?.name || "");
  if (!version?.settings?.generation) return name;
  const model = modelName(version, generators);
  if (!model) return name;
  const edit = name.match(/\bEdit (\d+)$/i);
  return edit ? `${model} · Edit ${edit[1]}` : model;
}

// A take's number, the one in its stored name, so a removed take doesn't
// renumber the rest. Older names without one fall back to their place.
export function takeNumber(version, index) {
  const match = String(version?.name || "").match(/#(\d+)/);
  return match ? match[1] : String(index);
}
