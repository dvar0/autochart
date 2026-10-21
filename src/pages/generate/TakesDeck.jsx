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
  DEFAULT_GENERATOR_ID,
  DEFAULT_TIMING_DETECTOR_ID,
  GENERATION_DIFFICULTIES,
  generationSummary,
  getGenerationPreset,
  SOURCE_CHART_TIMING_DETECTOR_ID,
  timingDetectorLabel,
  timingDetectorOptionFromResolved,
  timingSmoothingEnabledFromGeneration,
  usesOlderTimingSmoother,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import { FINAL_SLOT_ORDER, getVersionDifficulty } from "../../services/finalChart.js";
import { LiveGenerationTakeCard } from "./LiveGeneration.jsx";
import { StageSignal } from "./StageAnimations.jsx";
import {
  demucsAuditionKey,
  generatorStemSetId,
  MIN_COMPARE_CHARTS,
  separationStemSet,
} from "./useGenerateProject.js";

const STEM_OPTIONS = [
  { id: "other", label: "Other" },
  { id: "drums", label: "Drums" },
  { id: "bass", label: "Bass" },
  { id: "vocals", label: "Vocals" },
];

// Fretformer v1.2's htdemucs_6s stems (piano is folded into other).
const SIX_STEM_OPTIONS = [
  { id: "guitar", label: "Guitar" },
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
  return { text: `+${label}s`, title: `Lead-in silence: ${label} seconds`, mod: true };
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
  if (/^default separation$/i.test(base)) return `Default${suffix}`;
  const regenerated = base.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `Regen${regenerated[1] ? ` ${regenerated[1].trim()}` : ""}${suffix}`;
  return `${base.replace(/\s+separation$/i, " sep")}${suffix}`;
}

function separationKindTag(name = "") {
  return /^regenerated separation/i.test(baseSeparationName(name)) ? "regen" : null;
}

function separationCardName(artifact) {
  const base = baseSeparationName(artifact?.name);
  const variant = sourceVariantTag(artifact);
  const suffix = variant === "0s" ? "" : ` · ${variant}`;
  if (/^default separation$/i.test(base)) return `Default${suffix}`;
  const regenerated = base.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `Regen${regenerated[1] ? ` ${regenerated[1].trim()}` : ""}${suffix}`;
  return `${base}${suffix}`;
}

// Compact model identity for generated take tags.
function modelTag(version) {
  const label = String(version.settings?.model || "").trim();
  if (label) {
    return { text: label, title: label };
  }
  const generatorId = version.meta?.generatorId || version.settings?.generation?.generatorId || "";
  if (generatorId === DEFAULT_GENERATOR_ID) return { text: "Fretformer", title: generatorId };
  const tail = generatorId.split(".").pop();
  return tail ? { text: tail.toUpperCase(), title: generatorId } : null;
}

// At-a-glance run recipe: difficulty it was generated with, model, preset,
// sampling overrides (only when they differ from the preset), seed.
function takeTags(version, fallbackDifficulty, badgedGeneratorIds = new Set()) {
  const difficulty = getVersionDifficulty(version, fallbackDifficulty);
  const tags = [
    {
      text: DIFF[difficulty]?.name || difficulty,
      tone: slotTone(difficulty),
    },
  ];
  const generation = version.settings?.generation;
  if (version.source !== "generated" || !generation) return tags;

  const model = modelTag(version);
  const takeGeneratorId = version.meta?.generatorId || generation.generatorId || "";
  // Takes from a badged model (the v1.2 test model) wear its NEW amber.
  if (model) tags.push({ ...model, primary: true, keep: true, ...(badgedGeneratorIds.has(takeGeneratorId) ? { tone: "amber" } : {}) });

  const controls = generation.controls || {};
  const resolved = generation.resolved || {};
  const preset = getGenerationPreset(generation.presetId || controls.presetId);
  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  if (timingDetector !== DEFAULT_TIMING_DETECTOR_ID) {
    tags.push({
      text: timingDetectorLabel(timingDetector, { short: true }),
      title: `Timing: ${timingDetectorLabel(timingDetector)}`,
      primary: true,
    });
  }
  if (timingDetector !== SOURCE_CHART_TIMING_DETECTOR_ID) {
    const smoothing = timingSmoothingEnabledFromGeneration(generation);
    const older = usesOlderTimingSmoother(generation);
    tags.push({
      text: smoothing ? (older ? "old smooth" : "smooth") : "raw grid",
      title: smoothing
        ? (older ? "Beat map from the previous smoother" : "Timing smoothing enabled")
        : "Timing smoothing disabled",
      secondary: smoothing,
      mod: !smoothing,
    });
  }
  const leadIn = leadInTag(version);
  if (leadIn) tags.push(leadIn);
  tags.push({ text: generation.presetName || preset.name, secondary: true });
  const temperature = settingNumber(resolved.temperature ?? controls.temperature);
  if (temperature != null && Math.abs(temperature - preset.temperature) > 0.000001) {
    tags.push({ text: `T ${temperature}`, mod: true });
  }
  const topP = settingNumber(resolved.topP ?? controls.topP);
  if (topP != null && Math.abs(topP - preset.topP) > 0.000001) {
    tags.push({ text: `P ${topP}`, mod: true });
  }
  const knobValues = controls.knobs ?? resolved.knobs ?? {};
  let knobsActiveHere = false;
  for (const knob of ALL_DESCRIPTOR_KNOBS) {
    const value = knobValues[knob.id];
    if (value == null) continue;
    knobsActiveHere = true;
    tags.push({ text: `${knob.compact}${value}`, title: `${knob.name} ${value}`, mod: true });
  }
  const knobGuidance = settingNumber(resolved.guidanceScale ?? controls.guidanceScale);
  if (knobsActiveHere && knobGuidance != null && knobGuidance > 1) {
    tags.push({ text: `CFG ${knobGuidance}`, title: `Guidance ${knobGuidance}`, mod: true });
  }
  const seed = resolved.seed ?? (controls.seedMode === "fixed" ? controls.seed : null);
  tags.push({ text: seed != null ? `seed ${seed}` : "seed rnd", secondary: true });
  const demucsName = version.meta?.demucsName || version.provenance?.sourceSeparation?.name || "";
  const demucsVariant = leadIn?.text || "0s";
  if (demucsName) tags.push({ text: compactSeparationName(demucsName, demucsVariant), title: `Demucs: ${demucsName}`, secondary: true });
  return tags;
}

function versionDemucsId(version) {
  return version?.meta?.demucsId || version?.provenance?.sourceSeparation?.id || version?.settings?.demucsSeparation?.id || "";
}

function hasStemSet(artifact, stemSetId) {
  return Object.values(separationStemSet(artifact, stemSetId)).some((stem) => stem?.path);
}

function artifactReady(artifact) {
  return STEM_SETS.some((stemSet) => hasStemSet(artifact, stemSet.id));
}

function fmtArtifactDate(value) {
  if (!value) return "on demand";
  return new Date(value).toLocaleString("en-US", {
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
    generatorForStemSet?.(stemSetId)?.label || (stemSetId === "htdemucs" ? "Fretformer" : stemSetId);

  const playStem = async (artifact, stem, stemSetId) => {
    setError("");
    try {
      await auditionDemucsStem(artifact, stem, stemSetId);
    } catch (err) {
      setError(err.message || "Could not play that stem.");
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
      setError(err.message || "Separation failed.");
    }
  };

  const regenerate = async () => {
    setError("");
    try {
      await prepareDemucsSeparation({ makeActive: true });
    } catch (err) {
      setError(err.message || "Separation failed.");
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
              <span className="live-rec-badge split"><i />SPLIT</span>
              <span className="take-name">Separating stems…</span>
            </div>
            <div className="live-take-viewport">
              <StageSignal size="strip" mode="split" />
            </div>
            <div className="gen-progressbar sm live-take-progress" aria-hidden="true">
              <i className="indeterminate" />
            </div>
            <div className="take-meta">Vocals, guitar, bass, drums</div>
          </div>
        )}

        {separationsNewestFirst.map((artifact, index) => {
          const compatible = (artifact.sourceVariantKey || "lead-in:0") === currentSourceVariantKey;
          const active = compatible && artifact.id === activeDemucsId;
          const usedByPreview = selectedDemucsId && selectedDemucsId === artifact.id;
          const ready = artifactReady(artifact);
          // v1's set is always listed (it separates on first play, as before);
          // another model's set is listed once it exists or while that model is selected.
          const stemSets = STEM_SETS.filter((stemSet) =>
            stemSet.id === "htdemucs" || stemSet.id === selectedStemSetId || hasStemSet(artifact, stemSet.id)
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
                <span className="version-badge">{(artifact.engineId || artifact.id) === "demucs_default" ? "D" : badgeIndex}</span>
                <span className="take-name" title={artifact.name}>{displayName}</span>
              </div>
              <div className="take-meta">
                {artifact.profile || "Standard Demucs"} · {ready ? fmtArtifactDate(artifact.updatedAt || artifact.createdAt) : "runs on first play"}
              </div>
              <div className="take-tags">
                <span className="take-tag mod" title={`Lead-in silence: ${sourceVariantTag(artifact)}`}>{sourceVariantTag(artifact)}</span>
                {kindTag && <span className="take-tag secondary" title={artifact.name}>{kindTag}</span>}
                {usedByPreview && <span className="take-tag">in current chart</span>}
                {!compatible && <span className="take-tag secondary">not current</span>}
              </div>
              {stemSets.map((stemSet) => {
                const label = stemSetLabel(stemSet.id);
                const heading = labelStemSets && (
                  <div className="demucs-set-label">{label} · {stemSet.stems.length} stems</div>
                );
                if (stemSet.id !== "htdemucs" && !hasStemSet(artifact, stemSet.id)) {
                  return (
                    <div className="demucs-set" key={stemSet.id}>
                      {heading}
                      <div
                        className="demucs-set-missing"
                        title={`${label} separates this audio itself. Its first chart on this separation makes these stems, or separate now.`}
                      >
                        <span>Not separated yet</span>
                        <button
                          type="button"
                          className="take-pip wide"
                          onClick={() => separateFor(artifact, stemSet.id)}
                          disabled={busy || !sourceAudioFile}
                          title={sourceAudioFile ? `Run the ${label} separation now` : "Choose media first"}
                        >
                          SEPARATE NOW
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
                            title={sourceAudioFile ? `Audition ${stem.label.toLowerCase()} in the preview stage` : "Choose media first"}
                          >
                            {loading ? <span className="cta-spinner" aria-hidden="true" /> : !labelStemSets && <I.play />}
                            {stem.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div className="demucs-card-actions">
                <button
                  className="take-pip wide on tone-red"
                  onClick={() => selectDemucsSeparation(artifact.id)}
                  disabled={busy || active || !compatible}
                  title={
                    !compatible
                      ? `Switch lead-in to ${sourceVariantTag(artifact)} to use this separation`
                      : active
                        ? "New charts use this separation"
                        : "Use this separation for new charts"
                  }
                >
                  {active ? "IN USE" : "USE FOR CHARTS"}
                </button>
              </div>
            </div>
          );
        })}

        <button
          className="take-card placeholder demucs-new-card"
          onClick={regenerate}
          disabled={busy || !sourceAudioFile}
          title={sourceAudioFile ? "Run Demucs again and keep both versions" : "Choose media first"}
        >
          <div className="take-card-top">
            <span className="version-badge">+</span>
            <span className="take-name">New separation</span>
          </div>
          <div className="take-meta">
            Run Demucs again for {currentSourceVariantLabel}
            {selectedStemSetId !== "htdemucs" ? ` (${stemSetLabel(selectedStemSetId)} stems)` : ""}
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
    startEditingVersion,
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
  const tagsById = new Map(takesNewestFirst.map((v) => [v.id, takeTags(v, project.diff, badgedGeneratorIds)]));
  // With two or more generated takes, a card only lists the settings that set
  // it apart. Difficulty and model always stay; the full recipe is the tooltip.
  const generatedTakes = takesNewestFirst.filter((v) => v.source === "generated" && v.settings?.generation);
  const sharedTagTexts = new Set(
    generatedTakes.length >= 2
      ? (tagsById.get(generatedTakes[0].id) || [])
        .map((tag) => tag.text)
        .filter((text) => generatedTakes.every((v) => tagsById.get(v.id).some((tag) => tag.text === text)))
      : []
  );

  return (
    <section className="takes-deck">
      <div className="takes-deck-head">
        <div className="deck-tabs" role="tablist" aria-label="Generation deck">
          <button
            className={deckTab === "takes" ? "active" : ""}
            onClick={() => setDeckTab("takes")}
            role="tab"
            aria-selected={deckTab === "takes"}
          >
            TAKES <span>{candidateVersions.length}</span>
          </button>
          <button
            className={showingDemucs ? "active" : ""}
            onClick={() => setDeckTab("demucs")}
            role="tab"
            aria-selected={showingDemucs}
          >
            SEPARATION <span>{demucsArtifacts.length}</span>
          </button>
        </div>

        {!showingDemucs ? (
          <>
            <div className="final-strip" title={`Final chart · ${finalReadyLabel} assigned`}>
              <span className="final-strip-label">FINAL</span>
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
                        ? `${DIFF[difficulty]?.name || difficulty}: ${assigned.name} — click to preview`
                        : `${DIFF[difficulty]?.name || difficulty}: empty`
                    }
                    aria-label={`Final ${difficulty} slot${assigned ? `, ${assigned.name}` : ", empty"}`}
                  >
                    {SLOT_LETTERS[difficulty]}
                  </button>
                );
              })}
            </div>
            {finalTimingIssue && (
              <span className="final-timing-warning" title={finalTimingIssue}>Timing mismatch</span>
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
                  ? `Saving final chart to ${GAME_LIBRARY_NAME}`
                  : justSavedLibrary
                    ? `Saved final chart to ${GAME_LIBRARY_NAME}`
                    : `Save final chart to ${GAME_LIBRARY_NAME}`
              }
              disabled={busy || !songId || !finalFilledCount || Boolean(finalTimingIssue)}
              title={
                !songId
                  ? "Import and save a song first"
                  : !finalFilledCount
                    ? "Assign at least one difficulty"
                    : finalTimingIssue || `Save an Autochart copy to your ${GAME_LIBRARY_NAME} songs folder`
              }
            >
              {savingLibrary ? (
                <>
                  <span className="cta-spinner" aria-hidden="true" /> {GAME_LIBRARY_SAVING_LABEL}
                </>
              ) : justSavedLibrary ? (
                <>
                  {GAME_LIBRARY_SAVED_LABEL} <span className="save-check-pop" aria-hidden="true"><I.check /></span>
                </>
              ) : (
                <>
                  {GAME_LIBRARY_SAVE_LABEL} <I.check />
                </>
              )}
            </button>

            <button
              className="deck-export"
              onClick={handleExportFinal}
              disabled={busy || !songId || !finalFilledCount || Boolean(finalTimingIssue)}
              title={
                !songId
                  ? "Import and save a song first"
                  : !finalFilledCount
                    ? "Assign at least one difficulty"
                    : finalTimingIssue || undefined
              }
            >
              {busyAction === "exporting" ? "EXPORTING…" : "EXPORT"} <I.upload />
            </button>

            <button
              className={"deck-compare-btn" + (previewMode === "compare" ? " active" : "")}
              onClick={toggleCompareMode}
              disabled={previewMode !== "compare" && compareSelection.length < MIN_COMPARE_CHARTS}
              title={
                previewMode === "compare"
                  ? "Back to single preview"
                  : compareSelection.length < MIN_COMPARE_CHARTS
                    ? "Check at least two takes to compare"
                    : undefined
              }
            >
              {previewMode === "compare" ? "✕ Comparing" : `Compare (${compareSelection.length})`}
            </button>
          </>
        ) : (
          <>
            <div className="demucs-headline">
              <span>Active</span>
              <b>{activeDemucsArtifact?.name || "Default separation"}</b>
            </div>
            <button
              className={"deck-compare-btn" + (demucsAuditionMode === "compare" ? " active" : "")}
              onClick={() => setDemucsAuditionMode(demucsAuditionMode === "compare" ? "single" : "compare")}
              disabled={busy}
              title={demucsAuditionMode === "compare" ? "Back to single stem audition" : "Compare two separated stems"}
            >
              {demucsAuditionMode === "compare" ? "✕ Comparing" : "Compare"}
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
              const sparkDuration = v.meta?.durationSec || fallbackDuration;
              const tags = (tagsById.get(v.id) || []).filter(
                (tag, index) => index === 0 || tag.keep || !sharedTagTexts.has(tag.text)
              );
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
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      previewVersion(v.id);
                    }
                  }}
                >
                  <div className="take-card-top">
                    <span className="version-badge">{v.badge}</span>
                    <span className="take-name" title={v.name}>{v.name}</span>
                    <div className="take-card-actions">
                      {removable && (
                        <button
                          className="take-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCandidate(v);
                          }}
                          disabled={busy}
                          title="Remove take"
                          aria-label={`Remove ${v.name}`}
                          tabIndex={showingDemucs ? -1 : 0}
                        >
                          <I.trash />
                        </button>
                      )}
                      <label
                        className="take-check"
                        title="Mark for compare"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={inCompare}
                          onChange={() => toggleCompareSelection(v.id)}
                          aria-label={`Compare ${v.name}`}
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
                  <div className="take-meta">{v.noteCount || "--"} notes</div>
                  <div
                    className="take-tags"
                    title={v.source === "generated" ? generationSummary(v.settings) : undefined}
                  >
                    {v.meta?.edited && <span className="take-tag mod" title="Edited draft">edited</span>}
                    {tags.map((tag) => (
                      <span
                        key={tag.text}
                        className={
                          "take-tag" +
                          (tag.mod ? " mod" : "") +
                          (tag.tone ? ` tone-${tag.tone}` : "") +
                          (tag.primary ? " primary" : "") +
                          (tag.secondary ? " secondary" : "")
                        }
                        title={tag.title}
                      >
                        {tag.text}
                      </span>
                    ))}
                  </div>
                  <div className="take-actions-row" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="take-action edit"
                      onClick={() => startEditingVersion(v.id)}
                      disabled={busy || !assignable}
                      title={assignable ? "Edit notes or redo parts of this take" : "This take has no chart to edit"}
                      tabIndex={showingDemucs ? -1 : 0}
                    >
                      <I.pencil /> Edit
                    </button>
                    <button
                      type="button"
                      className={"take-action" + (reusedFrom?.id === v.id ? " is-current" : "")}
                      onClick={() => reuseVersionSettings(v.id)}
                      disabled={busy || !reusable}
                      title={reusable ? "Load this take's settings, seed included, into the console" : "This take wasn't generated here"}
                      tabIndex={showingDemucs ? -1 : 0}
                    >
                      <I.reuse /> Use settings
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
                              ? "This take has no exportable chart"
                              : on
                                ? `Clear final ${DIFF[difficulty]?.name || difficulty}`
                                : `Use for final ${DIFF[difficulty]?.name || difficulty}`
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
              );
            })}

            {!candidateVersions.length && !generating && (
              <div className="take-card placeholder">
                <div className="take-card-top">
                  <span className="version-badge">1</span>
                  <span className="take-name">Next generation</span>
                </div>
                <div className="take-meta">{difficultyName} · {selectedPreset.name} · -- notes</div>
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
