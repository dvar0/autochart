// How Settings and the model picker present the engine's generators. A family
// is one download (its catalog pack): its generator drafts charts (Generate),
// and its inpaint generator, when it has one, rewrites picked bars (Inpaint).
export const MODEL_FAMILIES = Object.freeze([
  Object.freeze({
    id: "fretformer-2",
    label: "Fretformer 2",
    badge: "2",
    recommended: true,
    about: "Writes charts. Comes with Fill-in.",
    shortLabel: "Fretformer 2",
    generatorId: "autochart.fretformer.v2-onnx",
    inpaintGeneratorId: "autochart.fretformer.v2-inpaint-onnx",
    packId: "fretformer-2",
    // What the browser version downloads for Generate (the Inpaint model is extra).
    downloadMb: 500,
  }),
  Object.freeze({
    id: "fretformer-1",
    label: "Fretformer 1",
    badge: "1",
    about: "The first model. Writes charts.",
    shortLabel: "Fretformer 1",
    generatorId: "autochart.fretformer.v1-onnx",
    packId: "standard-onnx",
    // Not in the browser version.
    desktopOnly: true,
  }),
  Object.freeze({
    id: "fretformer-2-lite",
    label: "Fretformer 2 Lite",
    badge: "L",
    experimental: true,
    about: "Faster, less accurate. Has its own Fill-in.",
    shortLabel: "Lite",
    generatorId: "autochart.fretformer.v2-lite-onnx",
    inpaintGeneratorId: "autochart.fretformer.v2-lite-onnx",
    packId: "fretformer-2-lite",
    downloadMb: 555,
  }),
]);

// Models that come with a family's download and normally only redo picked
// bars. With the "fillInDrafts" setting on they can also write whole charts,
// offered as Beta.
export const BETA_MODELS = Object.freeze([
  Object.freeze({
    id: "fretformer-2-fill-in",
    label: "Fill-in",
    badge: "F",
    familyId: "fretformer-2",
    about: "Redoes the parts you pick.",
    shortLabel: "Fill-in",
    generatorId: "autochart.fretformer.v2-inpaint-onnx",
  }),
]);

export const CATALOG_DEFAULT_GENERATOR_ID = "autochart.fretformer.v2-onnx";

const BETA_GENERATOR_IDS = new Set(BETA_MODELS.map((model) => model.generatorId));

export function isBetaGenerator(generatorId) {
  return BETA_GENERATOR_IDS.has(generatorId);
}

// Generators marked availability "installed" (test models) are offered only
// once their model folder is present; every other generator is always listed.
// Beta drafting models are offered only while the "fillInDrafts" setting is on.
export function selectableGeneratorsFrom(generators = [], preferences = {}) {
  return generators.filter((generator) =>
    (generator.availability !== "installed" || generator.setup?.ready)
    && (preferences.fillInDrafts || !isBetaGenerator(generator.id)));
}

// The generator new projects start on: the user's pick while it is usable,
// then the catalog default if it's downloaded, then any downloaded generator,
// then the catalog default (so Generate offers its download).
export function defaultGeneratorIdFrom(generators = [], preferences = {}) {
  const usable = selectableGeneratorsFrom(generators, preferences);
  const ids = new Set(usable.map((generator) => generator.id));
  const ready = usable.filter((generator) => generator.setup?.ready);
  const preferred = preferences.defaultGeneratorId;
  if (preferred && ids.has(preferred)) return preferred;
  if (ready.some((generator) => generator.id === CATALOG_DEFAULT_GENERATOR_ID)) return CATALOG_DEFAULT_GENERATOR_ID;
  if (ready.length) return ready[0].id;
  if (ids.has(CATALOG_DEFAULT_GENERATOR_ID)) return CATALOG_DEFAULT_GENERATOR_ID;
  return usable[0]?.id || CATALOG_DEFAULT_GENERATOR_ID;
}
