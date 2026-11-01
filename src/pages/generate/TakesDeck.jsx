import { useEffect, useState } from "react";
import DensityStrip from "../../highway/DensityStrip.jsx";
import { DIFF } from "../../data/difficultyMetadata.js";
import {
  GAME_LIBRARY_NAME,
  GAME_LIBRARY_SAVE_LABEL,
  GAME_LIBRARY_SAVED_LABEL,
  GAME_LIBRARY_SAVING_LABEL,
} from "../../data/gameLibrary.js";
import {
  ALL_DESCRIPTOR_KNOBS,
  DEFAULT_TIMING_DETECTOR_ID,
  GENERATION_DIFFICULTIES,
  GENERATION_PRESETS,
  getGenerationPreset,
  timingDetectorLabel,
  timingDetectorOptionFromResolved,
  timingSmoothingEnabledFromGeneration,
  usesOlderTimingSmoother,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import { FINAL_SLOT_ORDER, getVersionDifficulty } from "../../services/finalChart.js";
import { LiveGenerationTakeCard } from "./LiveGeneration.jsx";
import { modelName, takeCardName } from "./takeNames.js";
import { StageSignal } from "./StageAnimations.jsx";
import {
  demucsAuditionKey,
  generatorStemSetId,
  hasSeparation,
  MIN_COMPARE_CHARTS,
  separationStemSet,
} from "./useGenerateProject.js";
import { leadInText, separationName } from "./separationNames.js";
import { formatDate, msg, t, tn } from "../../i18n/index.js";

const STEM_OPTIONS = [
  { id: "other", label: msg("Other") },
  { id: "drums", label: msg("Drums") },
  { id: "bass", label: msg("Bass") },
  { id: "vocals", label: msg("Vocals") },
];

// htdemucs_6s stems (piano is folded into other). The six-stem models use these.
const SIX_STEM_OPTIONS = [
  { id: "guitar", label: msg("Guitar") },
  ...STEM_OPTIONS,
];

// The stem sets a separation card can list, one per separation model.
const STEM_SETS = [
  { id: "htdemucs", stems: STEM_OPTIONS },
  { id: "htdemucs_6s", stems: SIX_STEM_OPTIONS },
];

const SLOT_LETTERS = { easy: "E", medium: "M", hard: "H", expert: "X" };

function slotTone(difficulty) {
  return GENERATION_DIFFICULTIES.find((option) => option.id === difficulty)?.tone || "red";
}

// One take can fill several final slots. The card wears the colour of the
// hardest slot it holds; the pip row spells out the full set.
function assignedSlotTone(finalSlots, versionId) {
  const filled = FINAL_SLOT_ORDER.filter((difficulty) => finalSlots[difficulty] === versionId);
  return filled.length ? slotTone(filled[filled.length - 1]) : null;
}

function settingNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function leadInTag(version) {
  const ms = Number(version.meta?.leadInSilenceMs || version.provenance?.sourceTransform?.leadInSilenceMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  const label = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "");
  return { text: `+${label}s`, title: t("Lead-in silence: {seconds} seconds", { seconds: label }), mod: true };
}

function sourceVariantTag(artifact) {
  const ms = Number(artifact?.sourceTransform?.leadInSilenceMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  return `+${Number.isInteger(seconds) ? seconds : seconds.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "")}s`;
}

function baseSeparationName(name = "") {
  return String(name || "Default separation").replace(/\s*\([^)]*lead-in[^)]*\)\s*$/i, "").trim();
}

function compactSeparationName(name = "", variant = "0s") {
  const base = baseSeparationName(name);
  const suffix = variant === "0s" ? "" : ` · ${variant}`;
  if (/^default separation$/i.test(base)) return `${t("Default")}${suffix}`;
  const regenerated = base.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `${regenerated[1] ? t("Remake {number}", { number: regenerated[1].trim() }) : t("Remake")}${suffix}`;
  return `${base.replace(/\s+separation$/i, " sep")}${suffix}`;
}

function separationKindTag(name = "") {
  return /^regenerated separation/i.test(baseSeparationName(name)) ? t("remade") : null;
}

function separationCardName(artifact) {
  const base = baseSeparationName(artifact?.name);
  const variant = sourceVariantTag(artifact);
  const suffix = variant === "0s" ? "" : ` · ${variant}`;
  if (/^default separation$/i.test(base)) return `${t("Default")}${suffix}`;
  const regenerated = base.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `${regenerated[1] ? t("Remake {number}", { number: regenerated[1].trim() }) : t("Remake")}${suffix}`;
  return `${base}${suffix}`;
}

const KNOB_COLORS = ["var(--fret-g)", "var(--fret-r)", "var(--fret-y)", "var(--fret-b)", "var(--fret-o)"];

// Sampling presets wear a temperature colour: safe is green, the default is
// neutral, wild is peach. Values off any preset are purple, like every
// other hand-set value.
const PRESET_TONES = { tight: "green", wild: "peach" };

function formatSetting(value) {
  return String(Number(value.toFixed(2)));
}

// The model a take came from, as the chip beside its difficulty.
function takeModel(version, generators, badgedGeneratorIds) {
  const generation = version.settings?.generation;
  if (version.source !== "generated" || !generation) return null;
  const generatorId = version.meta?.generatorId || generation.generatorId || "";
  const name = modelName(version, generators);
  return name ? { text: name, title: generatorId || name, tone: badgedGeneratorIds.has(generatorId) ? "amber" : null } : null;
}

// A generated take's full recipe as labelled rows. `compare` is what the deck
// checks across takes to highlight the values that set a take apart; `chips`
// replace the plain value where colour carries meaning.
function takeRecipe(version, generators = []) {
  const generation = version.settings?.generation;
  if (version.source !== "generated" || !generation) return null;
  const controls = generation.controls || {};
  const resolved = generation.resolved || {};

  const seed = resolved.seed ?? (controls.seedMode === "fixed" ? controls.seed : null);
  const leadIn = leadInTag(version)?.text || "0s";

  const savedPreset = getGenerationPreset(generation.presetId || controls.presetId);
  const temperature = settingNumber(resolved.temperature ?? controls.temperature) ?? savedPreset.temperature;
  const topP = settingNumber(resolved.topP ?? controls.topP) ?? savedPreset.topP;
  // Hand-typed values that land exactly on a preset read as that preset.
  const matches = (item) => Math.abs(temperature - item.temperature) < 0.000001 && Math.abs(topP - item.topP) < 0.000001;
  const preset = matches(savedPreset) ? savedPreset : GENERATION_PRESETS.find(matches);
  const presetName = preset?.name || generation.presetName || savedPreset.name;
  const sampling = !preset
    ? {
      value: `T ${formatSetting(temperature)} · P ${formatSetting(topP)}`,
      chips: [{ text: t("Custom"), tone: "purple" }],
      title: t("Temperature {temperature} · Top-p {topP}", { temperature, topP }),
      mod: true,
    }
    : {
      value: "",
      chips: [{ text: t(presetName), tone: PRESET_TONES[preset.id] || "neutral" }],
      title: t("{preset}: temperature {temperature} · top-p {topP}", { preset: t(presetName), temperature, topP }),
    };

  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  let timing;
  if (timingDetector !== DEFAULT_TIMING_DETECTOR_ID) {
    timing = { value: timingDetectorLabel(timingDetector, { short: true }), title: timingDetectorLabel(timingDetector) };
  } else if (timingSmoothingEnabledFromGeneration(generation)) {
    timing = usesOlderTimingSmoother(generation)
      ? { value: t("old smooth"), title: t("Beat map from the previous smoother"), tone: "amber" }
      : { value: t("smooth"), title: t("Smoothed beat map") };
  } else {
    timing = { value: t("raw"), title: t("Beat map without smoothing"), mod: true };
  }

  const knobValues = controls.knobs ?? resolved.knobs ?? {};
  const knobs = Object.keys(knobValues).map((id, index) => {
    const knob = ALL_DESCRIPTOR_KNOBS.find((item) => item.id === id);
    return {
      name: knob?.name ? t(knob.name) : id,
      compact: knob?.compact || id.slice(0, 2),
      value: knobValues[id],
      color: KNOB_COLORS[index % KNOB_COLORS.length],
    };
  });
  const setKnobs = knobs.filter((knob) => knob.value != null);
  const guidance = settingNumber(resolved.guidanceScale ?? controls.guidanceScale);
  const styleTitle = knobs.length
    ? knobs.map((knob) => `${knob.name} ${knob.value ?? t("auto")}`).join(" · ") + (setKnobs.length && guidance != null ? ` · ${t("strength {value}", { value: guidance })}` : "")
    : t("This model has no style controls");

  const demucsName = version.meta?.demucsName || version.provenance?.sourceSeparation?.name || "";
  // Models that read only the full mix (Lite) never used a separation.
  const generatorId = version.meta?.generatorId || generation.generatorId || "";
  const fullMix = generators.find((item) => item.id === generatorId)?.capabilities?.usesStemCache === false;

  return [
    { key: "seed", label: t("Seed"), value: seed != null ? String(seed) : t("random") },
    { key: "lead", label: t("Lead-in"), value: leadIn, title: t("Lead-in silence: {seconds}", { seconds: leadIn }), faint: leadIn === "0s" },
    { key: "timing", label: t("Timing"), ...timing },
    fullMix
      ? { key: "audio", label: t("Audio"), value: t("Full mix"), title: t("Reads the full mix, no separation") }
      : {
        key: "audio", label: t("Audio"), value: demucsName ? compactSeparationName(demucsName) : t("Default"),
        title: t("Separation: {name}", { name: separationName(demucsName) }),
      },
    { key: "sampling", label: t("Sampling"), full: true, compare: `${presetName}|${temperature}|${topP}`, ...sampling },
    {
      key: "style", label: t("Style"), full: true, title: styleTitle, compare: styleTitle,
      value: setKnobs.length ? "" : knobs.length ? t("auto") : t("none"),
      faint: !setKnobs.length,
      chips: setKnobs.map((knob) => ({ text: `${knob.compact} ${knob.value}`, color: knob.color })),
    },
  ];
}

function RecipeValue({ row }) {
  if (!row.chips?.length) return row.value;
  return (
    <>
      {row.chips.map((chip) => (
        <span
          key={chip.text}
          className={"recipe-chip" + (chip.tone ? ` tone-${chip.tone}` : "")}
          style={chip.color ? { "--chip": chip.color } : undefined}
        >
          {chip.text}
        </span>
      ))}
      {row.value && <span className="recipe-chip-note">{row.value}</span>}
    </>
  );
}

function versionDemucsId(version) {
  return version?.meta?.demucsId || version?.provenance?.sourceSeparation?.id || version?.settings?.demucsSeparation?.id || "";
}

function artifactReady(artifact) {
  return STEM_SETS.some((stemSet) => hasSeparation(artifact, stemSet.id));
}

function fmtArtifactDate(value) {
  if (!value) return t("on demand");
  return formatDate(value, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function DemucsPanel({ project }) {
  const {
    busy,
    busyAction,
    demucsArtifacts,
    activeDemucsId,
    demucsAudition,
    demucsAuditionLoadingKey,
    auditionDemucsStem,
    prepareDemucsSeparation,
    selectDemucsSeparation,
    selectedSingleVersion,
    sourceAudioFile,
    currentSourceVariantKey,
    currentSourceVariantLabel,
    selectedGenerator,
    generatorForStemSet,
  } = project;
  const [error, setError] = useState("");
  const selectedStemSetId = generatorStemSetId(selectedGenerator);
  const stemSetLabel = (stemSetId) =>
    generatorForStemSet?.(stemSetId)?.label || (stemSetId === "htdemucs" ? "Fretformer 1" : stemSetId);

  const playStem = async (artifact, stem, stemSetId) => {
    setError("");
    try {
      await auditionDemucsStem(artifact, stem, stemSetId);
    } catch (err) {
      setError(err.message || t("Could not play that stem."));
    }
  };

  // Separate an existing separation (same lead-in) with another model's Demucs.
  const separateFor = async (artifact, stemSetId) => {
    setError("");
    try {
      await prepareDemucsSeparation({
        id: artifact.id,
        name: artifact.name,
        makeActive: artifact.id === activeDemucsId,
        sourceTransform: artifact.sourceTransform || null,
        generator: generatorForStemSet?.(stemSetId) || selectedGenerator,
      });
    } catch (err) {
      setError(err.message || t("Separation failed."));
    }
  };

  const regenerate = async () => {
    setError("");
    try {
      await prepareDemucsSeparation({ makeActive: true });
    } catch (err) {
      setError(err.message || t("Separation failed."));
    }
  };

  const selectedDemucsId = versionDemucsId(selectedSingleVersion);
  const separating = busyAction === "separating";
  const separationsNewestFirst = [...demucsArtifacts].reverse();

  return (
    <>
      <div className="takes-row demucs-row">
        {separating && (
          <div className="take-card ghost live-take-card is-separating" aria-live="polite">
            <div className="take-card-top">
              <span className="live-dot" aria-hidden="true"><i /></span>
              <span className="take-name">{t("Separating stems…")}</span>
            </div>
            <div className="live-take-viewport">
              <StageSignal size="strip" mode="split" />
            </div>
            <div className="gen-progressbar sm live-take-progress" aria-hidden="true">
              <i className="indeterminate" />
            </div>
            <div className="take-meta">{t("Vocals, guitar, bass, drums")}</div>
          </div>
        )}

        {separationsNewestFirst.map((artifact, index) => {
          const compatible = (artifact.sourceVariantKey || "lead-in:0") === currentSourceVariantKey;
          const active = compatible && artifact.id === activeDemucsId;
          const usedByPreview = selectedDemucsId && selectedDemucsId === artifact.id;
          const ready = artifactReady(artifact);
          // v1's set is listed while v1 is installed (it separates on first play, as
          // before); any set is listed once it exists or while its model is selected.
          const stemSets = STEM_SETS.filter((stemSet) =>
            (stemSet.id === "htdemucs" && generatorForStemSet?.("htdemucs"))
            || stemSet.id === selectedStemSetId
            || hasSeparation(artifact, stemSet.id)
          );
          const labelStemSets = stemSets.length > 1;
          const badgeIndex = demucsArtifacts.length - 1 - index;
          const displayName = separationCardName(artifact);
          const kindTag = separationKindTag(artifact.name);
          return (
            <div
              key={artifact.id}
              className={
                "take-card demucs-card" +
                (labelStemSets ? " multi" : "") +
                (active ? " selected" : "") +
                (usedByPreview && !active ? " is-highlight" : "")
              }
            >
              <div className="take-card-top">
                <span className="version-badge">{badgeIndex + 1}</span>
                <span className="take-name" title={separationName(artifact.name)}>{displayName}</span>
              </div>
              <div className="take-meta">
                {!artifact.profile || artifact.profile === "Standard Demucs" ? t("Standard Demucs") : artifact.profile} · {ready ? fmtArtifactDate(artifact.updatedAt || artifact.createdAt) : t("runs on first play")}
              </div>
              <div className="take-tags">
                <span className="take-tag mod" title={t("Lead-in silence: {seconds}", { seconds: sourceVariantTag(artifact) })}>{sourceVariantTag(artifact)}</span>
                {kindTag && <span className="take-tag secondary" title={separationName(artifact.name)}>{kindTag}</span>}
                {usedByPreview && <span className="take-tag">{t("in current chart")}</span>}
                {!compatible && <span className="take-tag secondary">{t("not current")}</span>}
              </div>
              {stemSets.map((stemSet) => {
                const label = stemSetLabel(stemSet.id);
                const heading = labelStemSets && (
                  <div className="demucs-set-label">{label} · {tn(stemSet.stems.length, "{count} stem", "{count} stems")}</div>
                );
                if (stemSet.id !== "htdemucs" && !hasSeparation(artifact, stemSet.id)) {
                  return (
                    <div className="demucs-set" key={stemSet.id}>
                      {heading}
                      <div
                        className="demucs-set-missing"
                        title={t("{model} separates this audio itself. Its first chart on this separation makes these stems, or separate now.", { model: label })}
                      >
                        <span>{t("Not separated yet")}</span>
                        <button
                          type="button"
                          className="take-pip wide"
                          onClick={() => separateFor(artifact, stemSet.id)}
                          disabled={busy || !sourceAudioFile}
                          title={sourceAudioFile ? t("Run the {model} separation now", { model: label }) : t("Choose media first")}
                        >
                          {t("Separate now")}
                        </button>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="demucs-set" key={stemSet.id}>
                    {heading}
                    <div
                      className={"demucs-stem-grid" + (labelStemSets ? " compact" : "")}
                      style={labelStemSets ? { "--stem-cols": stemSet.stems.length } : undefined}
                    >
                      {stemSet.stems.map((stem) => {
                        const key = demucsAuditionKey(artifact.id, stemSet.id, stem.id);
                        const loading = demucsAuditionLoadingKey === key;
                        const auditioning = demucsAudition?.id === artifact.id && demucsAudition?.stem === stem.id &&
                          (demucsAudition?.stemSet || "htdemucs") === stemSet.id;
                        return (
                          <button
                            key={stem.id}
                            className={auditioning ? "active" : ""}
                            onClick={() => playStem(artifact, stem.id, stemSet.id)}
                            disabled={busy || loading || !sourceAudioFile}
                            title={
                              !sourceAudioFile
                                ? t("Choose media first")
                                : separationStemSet(artifact, stemSet.id)[stem.id]?.path
                                  ? t("Play the {stem} stem on the stage", { stem: t(stem.label).toLowerCase() })
                                  : t("Separates this song again to play the {stem} stem", { stem: t(stem.label).toLowerCase() })
                            }
                          >
                            {loading ? <span className="cta-spinner" aria-hidden="true" /> : !labelStemSets && <I.play />}
                            {t(stem.label)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="demucs-card-actions">
                <button
                  className={"take-pip wide use-pip" + (active ? " on" : "")}
                  onClick={() => selectDemucsSeparation(artifact.id)}
                  disabled={busy || active || !compatible}
                  title={
                    !compatible
                      ? t("Switch lead-in to {seconds} to use this separation", { seconds: sourceVariantTag(artifact) })
                      : active
                        ? t("New charts use this separation")
                        : t("Use this separation for new charts")
                  }
                >
                  {active ? t("In use") : t("Use for charts")}
                </button>
              </div>
            </div>
          );
        })}

        <button
          className="take-card placeholder demucs-new-card"
          onClick={regenerate}
          disabled={busy || !sourceAudioFile}
          title={sourceAudioFile ? t("Separate the song again and keep both") : t("Choose media first")}
        >
          <div className="take-card-top">
            <span className="version-badge">+</span>
            <span className="take-name">{t("New separation")}</span>
          </div>
          <div className="take-meta">
            {t("Separate again for {leadIn}", { leadIn: leadInText(currentSourceVariantLabel) })}
            {selectedStemSetId !== "htdemucs" ? ` ${t("({model} stems)", { model: stemSetLabel(selectedStemSetId) })}` : ""}
          </div>
        </button>
      </div>
      {error && <div className="demucs-error">{error}</div>}
    </>
  );
}

export default function TakesDeck({ project }) {
  const {
    importedSong,
    busy,
    busyAction,
    candidateVersions,
    cleanedFinalSlots,
    finalSlotVersions,
    finalFilledCount,
    finalReadyLabel,
    updateFinalSlot,
    removeCandidate,
    previewMode,
    previewVersion,
    setLiveStageFocused,
    showingLiveStage,
    selectedSingleVersion,
    compareSelection,
    toggleCompareSelection,
    toggleCompareMode,
    handleExportFinal,
    handleSaveFinalToLibrary,
    librarySavedAt,
    finalTimingIssue,
    songId,
    difficultyName,
    selectedPreset,
    deckTab,
    setDeckTab,
    demucsArtifacts,
    activeDemucsArtifact,
    demucsAuditionMode,
    setDemucsAuditionMode,
    reuseVersionSettings,
    reusedFrom,
    justGeneratedId,
  } = project;
  const badgedGeneratorIds = new Set((project.generators || []).filter((generator) => generator.badge).map((generator) => generator.id));

  // Hovering a FINAL chip highlights the take card that fills that slot, so
  // the chip↔card link reads without any extra chrome.
  const [highlightVersionId, setHighlightVersionId] = useState("");

  const generating = busyAction === "generating";
  const savingLibrary = busyAction === "saving-library";

  // Flash a "Saved" confirmation on the deck button for a beat after a
  // successful library write, then settle back to the resting label.
  const [justSavedLibrary, setJustSavedLibrary] = useState(false);
  useEffect(() => {
    if (!librarySavedAt) return undefined;
    setJustSavedLibrary(true);
    const timer = setTimeout(() => setJustSavedLibrary(false), 2200);
    return () => clearTimeout(timer);
  }, [librarySavedAt]);

  const fallbackDuration = importedSong?.meta?.durationSec || 0;
  const showingDemucs = deckTab === "demucs";
  const takesNewestFirst = [...candidateVersions].reverse();
  const recipesById = new Map(
    takesNewestFirst.map((v) => [v.id, takeRecipe(v, project.generators || [])])
  );
  // Every card shows its whole recipe; with two or more generated takes, the
  // values that differ between them are the bright ones.
  const recipes = [...recipesById.values()].filter(Boolean);
  const differingKeys = new Set(
    recipes.length >= 2
      ? recipes[0]
        .filter((row) => recipes.some((rows) => {
          const other = rows.find((item) => item.key === row.key);
          return (other?.compare ?? other?.value) !== (row.compare ?? row.value);
        }))
        .map((row) => row.key)
      : []
  );

  return (
    <section className="takes-deck">
      <div className="takes-deck-head">
        <div className="segmented deck-tabs" role="tablist" aria-label={t("Generation deck")}>
          <button
            className={deckTab === "takes" ? "active" : ""}
            onClick={() => setDeckTab("takes")}
            role="tab"
            aria-selected={deckTab === "takes"}
          >
            {t("Takes")} <span>{candidateVersions.length}</span>
          </button>
          <button
            className={showingDemucs ? "active" : ""}
            onClick={() => setDeckTab("demucs")}
            role="tab"
            aria-selected={showingDemucs}
          >
            {t("Separation")} <span>{demucsArtifacts.length}</span>
          </button>
        </div>

        {!showingDemucs ? (
          <>
            <div className="final-strip" title={t("Final chart · {count} assigned", { count: finalReadyLabel })}>
              <span className="final-strip-label">{t("Final")}</span>
              {FINAL_SLOT_ORDER.map((difficulty) => {
                const assigned = finalSlotVersions[difficulty];
                const tone = slotTone(difficulty);
                return (
                  <button
                    key={difficulty}
                    className={`final-chip tone-${tone}` + (assigned ? " filled" : "")}
                    onMouseEnter={() => assigned && setHighlightVersionId(assigned.id)}
                    onMouseLeave={() => setHighlightVersionId("")}
                    onClick={() => assigned && previewVersion(assigned.id)}
                    disabled={!assigned}
                    title={
                      assigned
                        ? t("{difficulty}: {take} — click to preview", { difficulty: DIFF[difficulty]?.name || difficulty, take: assigned.name })
                        : t("{difficulty}: empty", { difficulty: DIFF[difficulty]?.name || difficulty })
                    }
                    aria-label={assigned
                      ? t("Final {difficulty} slot, {take}", { difficulty: DIFF[difficulty]?.name || difficulty, take: assigned.name })
                      : t("Final {difficulty} slot, empty", { difficulty: DIFF[difficulty]?.name || difficulty })}
                  >
                    {SLOT_LETTERS[difficulty]}
                  </button>
                );
              })}
            </div>
            {finalTimingIssue && (
              <span className="final-timing-warning" title={finalTimingIssue}>{t("Timing mismatch")}</span>
            )}

            <button
              className={
                "deck-save-library" +
                (savingLibrary ? " is-saving" : "") +
                (justSavedLibrary ? " just-saved" : "")
              }
              onClick={handleSaveFinalToLibrary}
              aria-label={
                savingLibrary
                  ? t("Saving final chart to {library}", { library: GAME_LIBRARY_NAME })
                  : justSavedLibrary
                    ? t("Saved final chart to {library}", { library: GAME_LIBRARY_NAME })
                    : t("Save final chart to {library}", { library: GAME_LIBRARY_NAME })
              }
              disabled={busy || !songId || !finalFilledCount || Boolean(finalTimingIssue)}
              title={
                !songId
                  ? t("Import and save a song first")
                  : !finalFilledCount
                    ? t("Assign at least one difficulty")
                    : finalTimingIssue || t("Save an Autochart copy to your {library} songs folder", { library: GAME_LIBRARY_NAME })
              }
            >
              {savingLibrary ? (
                <>
                  <span className="cta-spinner" aria-hidden="true" /> {t(GAME_LIBRARY_SAVING_LABEL)}
                </>
              ) : justSavedLibrary ? (
                <>
                  <span className="save-check-pop" aria-hidden="true"><I.check /></span> {t(GAME_LIBRARY_SAVED_LABEL)}
                </>
              ) : (
                <>
                  <I.check /> {t(GAME_LIBRARY_SAVE_LABEL)}
                </>
              )}
            </button>

            <button
              className="deck-export"
              onClick={handleExportFinal}
              disabled={busy || !songId || !finalFilledCount || Boolean(finalTimingIssue)}
              title={
                !songId
                  ? t("Import and save a song first")
                  : !finalFilledCount
                    ? t("Assign at least one difficulty")
                    : finalTimingIssue || undefined
              }
            >
              <I.upload /> {busyAction === "exporting" ? t("Exporting…") : t("Export")}
            </button>

            <button
              className={"deck-compare-btn" + (previewMode === "compare" ? " active" : "")}
              onClick={toggleCompareMode}
              disabled={previewMode !== "compare" && compareSelection.length < MIN_COMPARE_CHARTS}
              title={
                previewMode === "compare"
                  ? t("Back to single preview")
                  : compareSelection.length < MIN_COMPARE_CHARTS
                    ? t("Check at least two takes to compare")
                    : undefined
              }
            >
              {previewMode === "compare" ? <><I.close /> {t("Comparing")}</> : t("Compare ({count})", { count: compareSelection.length })}
            </button>
          </>
        ) : (
          <>
            <div className="demucs-headline">
              <span>{t("In use")}</span>
              <b>{separationName(activeDemucsArtifact?.name)}</b>
            </div>
            <button
              className={"deck-compare-btn" + (demucsAuditionMode === "compare" ? " active" : "")}
              onClick={() => setDemucsAuditionMode(demucsAuditionMode === "compare" ? "single" : "compare")}
              disabled={busy}
              title={demucsAuditionMode === "compare" ? t("Back to playing one stem") : t("Compare two separated stems")}
            >
              {demucsAuditionMode === "compare" ? <><I.close /> {t("Comparing")}</> : t("Compare")}
            </button>
          </>
        )}
      </div>

      <div className="deck-body">
        <div className={"deck-pane" + (deckTab === "takes" ? " active" : "")} aria-hidden={showingDemucs}>
          <div className="takes-row">
            {generating && project.track && (
              <LiveGenerationTakeCard
                project={project}
                selected={showingLiveStage}
                onClick={() => setLiveStageFocused(true)}
              />
            )}

            {takesNewestFirst.map((v) => {
              const removable = v.source !== "imported-chart";
              const assignable = Boolean(v.chart?.text);
              const inCompare = compareSelection.includes(v.id);
              const isSelected = !showingLiveStage && previewMode === "single" && selectedSingleVersion?.id === v.id;
              const sparkNotes = v.track?.notes || [];
              // Older takes saved a zero duration; their last note stands in.
              const sparkDuration = v.meta?.durationSec || fallbackDuration
                || (sparkNotes.length ? sparkNotes[sparkNotes.length - 1].endTime || sparkNotes[sparkNotes.length - 1].time : 0);
              const recipe = recipesById.get(v.id);
              const model = takeModel(v, project.generators || [], badgedGeneratorIds);
              const difficulty = getVersionDifficulty(v, project.diff);
              const reusable = v.source === "generated" && Boolean(v.settings?.generation);
              const finalTone = assignedSlotTone(cleanedFinalSlots, v.id);
              return (
                <div
                  key={v.id}
                  className={
                    "take-card" +
                    (finalTone ? ` is-final tone-${finalTone}` : "") +
                    (isSelected ? " selected" : "") +
                    (inCompare ? " in-compare" : "") +
                    (highlightVersionId === v.id ? " is-highlight" : "") +
                    (justGeneratedId === v.id ? " just-added" : "")
                  }
                  onClick={(e) => {
                    if (e.shiftKey) toggleCompareSelection(v.id);
                    else previewVersion(v.id);
                  }}
                  role="button"
                  aria-pressed={isSelected}
                  tabIndex={showingDemucs ? -1 : 0}
                  // Enter picks the take; Space is left to play and pause, so
                  // a card still focused after a shift-click doesn't close compare.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      previewVersion(v.id);
                    }
                  }}
                >
                  <div className="take-card-top">
                    <span className="version-badge">{v.badge}</span>
                    <span className="take-name" title={takeCardName(v, project.generators || [])}>{takeCardName(v, project.generators || [])}</span>
                    <div className="take-card-actions">
                      {removable && (
                        <button
                          className="take-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCandidate(v);
                          }}
                          disabled={busy}
                          title={t("Remove take")}
                          aria-label={t("Remove {take}", { take: v.name })}
                          tabIndex={showingDemucs ? -1 : 0}
                        >
                          <I.trash />
                        </button>
                      )}
                      <label
                        className="take-check"
                        title={t("Mark for compare")}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={inCompare}
                          onChange={() => toggleCompareSelection(v.id)}
                          aria-label={t("Compare {take}", { take: v.name })}
                          tabIndex={showingDemucs ? -1 : 0}
                        />
                      </label>
                    </div>
                  </div>
                  {sparkNotes.length > 0 && sparkDuration > 0 && (
                    <div className="take-spark" aria-hidden="true">
                      <DensityStrip lanes={[{ notes: sparkNotes, solos: v.track?.solos }]} duration={sparkDuration} />
                    </div>
                  )}
                  <div className="take-meta-line">
                    <span className={`take-tag tone-${slotTone(difficulty)}`}>{DIFF[difficulty]?.name || difficulty}</span>
                    {model && (
                      <span className={"take-model" + (model.tone ? ` tone-${model.tone}` : "")} title={model.title}>
                        {model.text}
                      </span>
                    )}
                    <span className="take-notes">{v.noteCount ? tn(v.noteCount, "{count} note", "{count} notes") : t("-- notes")}</span>
                  </div>
                  {recipe ? (
                    <dl className="take-recipe">
                      {recipe.map((row) => (
                        <div
                          key={row.key}
                          className={
                            `recipe-row recipe-${row.key}` +
                            (row.full ? " full" : "") +
                            (differingKeys.has(row.key) ? " is-diff" : "") +
                            (row.mod ? " mod" : "") +
                            (row.faint ? " faint" : "") +
                            (row.chips?.length ? " has-chips" : "") +
                            (row.tone ? ` tone-${row.tone}` : "")
                          }
                          title={row.title}
                        >
                          <dt>{row.label}</dt>
                          <dd><RecipeValue row={row} /></dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="take-recipe-none">
                      {v.source === "imported-chart" ? t("From the imported chart") : t("Made outside Autochart")}
                    </p>
                  )}
                  <div className="take-foot">
                    <div className="take-actions-row" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={"take-action" + (reusedFrom?.id === v.id ? " is-current" : "")}
                        onClick={() => reuseVersionSettings(v.id)}
                        disabled={busy || !reusable}
                        title={reusable ? t("Load this take's settings, seed included, into the console") : t("This take wasn't generated here")}
                        tabIndex={showingDemucs ? -1 : 0}
                      >
                        <I.reuse /> {t("Use settings")}
                      </button>
                    </div>
                    <div className="take-pips" onClick={(e) => e.stopPropagation()}>
                      {FINAL_SLOT_ORDER.map((difficulty) => {
                        const tone = slotTone(difficulty);
                        const on = cleanedFinalSlots[difficulty] === v.id;
                        return (
                          <button
                            key={difficulty}
                            className={`take-pip tone-${tone}` + (on ? " on" : "")}
                            onClick={() => updateFinalSlot(difficulty, on ? "" : v.id)}
                            disabled={busy || !assignable}
                            title={
                              !assignable
                                ? t("This take has no exportable chart")
                                : on
                                  ? t("Clear final {difficulty}", { difficulty: DIFF[difficulty]?.name || difficulty })
                                  : t("Use for final {difficulty}", { difficulty: DIFF[difficulty]?.name || difficulty })
                            }
                            aria-pressed={on}
                            tabIndex={showingDemucs ? -1 : 0}
                          >
                            {SLOT_LETTERS[difficulty]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}

            {!candidateVersions.length && !generating && (
              <div className="take-card placeholder">
                <div className="take-card-top">
                  <span className="version-badge">1</span>
                  <span className="take-name">{t("Next generation")}</span>
                </div>
                <div className="take-meta">{difficultyName} · {t(selectedPreset.name)} · {t("-- notes")}</div>
              </div>
            )}
          </div>
        </div>

        <div className={"deck-pane" + (showingDemucs ? " active" : "")} aria-hidden={!showingDemucs}>
          <DemucsPanel project={project} />
        </div>
      </div>
    </section>
  );
}
