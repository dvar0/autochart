// How Settings and the model picker present the engine's generators. A family
// is one download: its generator drafts charts (Generate), and its inpaint
// generator, when it has one, rewrites picked bars (Inpaint).
export const MODEL_FAMILIES = Object.freeze([
  Object.freeze({
    id: "fretformer-2",
    label: "Fretformer 2",
    badge: "2",
    recommended: true,
    about: "Writes charts and redoes the parts you pick.",
    shortLabel: "Fretformer 2",
    generatorId: "autochart.fretformer.v2-dpo-onnx",
    inpaintGeneratorId: "autochart.fretformer.v2-dpo-fim-onnx",
  }),
  Object.freeze({
    id: "fretformer-1",
    label: "Fretformer 1",
    badge: "1",
    about: "The first model. Writes charts only.",
    shortLabel: "Fretformer 1",
    generatorId: "autochart.fretformer.v1-onnx",
  }),
]);

// Extra drafting models that come with a family's download, offered as Beta.
export const BETA_MODELS = Object.freeze([
  Object.freeze({
    id: "fretformer-2-fill-in",
    label: "Fretformer 2 Fill-in",
    shortLabel: "Fill-in",
    about: "Fretformer 2's Inpaint model writes the whole chart. Experimental.",
    generatorId: "autochart.fretformer.v2-dpo-fim-onnx",
  }),
]);

export const CATALOG_DEFAULT_GENERATOR_ID = "autochart.fretformer.v1-onnx";

const BETA_GENERATOR_IDS = new Set(BETA_MODELS.map((model) => model.generatorId));

export function isBetaGenerator(generatorId) {
  return BETA_GENERATOR_IDS.has(generatorId);
}

// Generators marked availability "installed" (test models) are offered only
// once their model folder is present; every other generator is always listed.
export function selectableGeneratorsFrom(generators = []) {
  return generators.filter((generator) => generator.availability !== "installed" || generator.setup?.ready);
}

// The generator new projects start on: the user's pick while it is usable,
// then the catalog default, then the first usable generator.
export function defaultGeneratorIdFrom(generators = [], preferences = {}) {
  const usable = selectableGeneratorsFrom(generators);
  const ids = new Set(usable.map((generator) => generator.id));
  const preferred = preferences.defaultGeneratorId;
  if (preferred && ids.has(preferred)) return preferred;
  if (ids.has(CATALOG_DEFAULT_GENERATOR_ID)) return CATALOG_DEFAULT_GENERATOR_ID;
  return usable[0]?.id || CATALOG_DEFAULT_GENERATOR_ID;
}
