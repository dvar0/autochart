import { useEffect, useRef, useState } from "react";
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
import {
  generatorStemSetId,
  MIN_COMPARE_CHARTS,
} from "./useGenerateProject.js";
import { leadInText } from "./separationNames.js";
import { stemRowsFor } from "./stemSets.js";
import { loadStemLevels } from "./stemMelGraphs.js";
import { t, tn } from "../../i18n/index.js";

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

  // Models that read only the full mix (Lite) never used a separation.
  const generatorId = version.meta?.generatorId || generation.generatorId || "";
  const fullMix = generators.find((item) => item.id === generatorId)?.capabilities?.usesStemCache === false;

  return [
    { key: "seed", label: t("Seed"), value: seed != null ? String(seed) : t("random") },
    { key: "lead", label: t("Lead-in"), value: leadIn, title: t("Lead-in silence: {seconds}", { seconds: leadIn }), faint: leadIn === "0s" },
    { key: "timing", label: t("Timing"), ...timing },
    fullMix
      ? { key: "audio", label: t("Audio"), value: t("Full mix"), title: t("Reads the full mix, no separation") }
      : { key: "audio", label: t("Audio"), value: t("Stems"), title: t("Reads the separated stems") },
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

// The stem channels a separation's tables hold (null until read).
// Each stem's loudness over the song (see loadStemLevels), or null while it loads.
function useStemLevels(tablesPath, rowIds) {
  const [levels, setLevels] = useState(null);
  const key = rowIds.join(",");
  useEffect(() => {
    setLevels(null);
    if (!tablesPath) return undefined;
    let cancelled = false;
    loadStemLevels(tablesPath, rowIds)
      .then((next) => {
        if (!cancelled) setLevels(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tablesPath, key]);
  return levels;
}

// A separation's stems as small lanes, one per stem in its color, so the card
// shows what the stage will play. A stem the separation lacks is an empty lane.
function StemLanes({ rows, levels }) {
  return (
    <div className="sep-lanes">
      {rows.map((stem) => {
        const level = levels?.[stem.id];
        const gone = levels && !level;
        return (
          <div
            key={stem.id}
            className={"sep-lane" + (gone ? " is-missing" : "")}
            style={{ "--stem": stem.color }}
          >
            <span className="sep-lane-name" title={gone ? t("Not in this separation") : undefined}>{t(stem.label)}</span>
            <svg className="sep-lane-bars" viewBox={`0 0 ${level?.length || 1} 2`} preserveAspectRatio="none" aria-hidden="true">
              {level && Array.from(level, (v, x) => {
                const h = Math.max(0.06, v * 2);
                return <rect key={x} x={x + 0.15} y={1 - h / 2} width={0.7} height={h} />;
              })}
            </svg>
          </div>
        );
      })}
    </div>
  );
}

// One lead-in's separation. Separating the same song again gives the same
// stems, so a lead-in has one; it only needs redoing when it's missing a stem
// this model has now (piano).
function SeparationCard({ row, rows, stemSetId, onStage, separating, busy, canSeparate, showing, onView, onSeparate }) {
  const tablesPath = row.artifact?.stemSets?.[stemSetId]?.melTables?.path || "";
  const levels = useStemLevels(row.separated ? tablesPath : "", rows.map((stem) => stem.id));
  const missing = levels ? rows.filter((stem) => !levels[stem.id]) : [];
  const name = leadInText(row.transform.label);
  const viewable = row.separated && !separating;
  const action = separating ? null : !row.separated ? t("Separate now") : missing.length ? t("Separate again") : null;
  return (
    <div
      className={
        "sep-card" +
        (onStage && viewable ? " selected" : "") +
        (row.current ? " is-current" : "") +
        (viewable ? "" : " is-empty")
      }
      onClick={viewable ? onView : undefined}
      role={viewable ? "button" : undefined}
      aria-pressed={viewable ? onStage : undefined}
      tabIndex={viewable && showing ? 0 : -1}
      onKeyDown={(e) => {
        if (viewable && e.key === "Enter") {
          e.preventDefault();
          onView();
        }
      }}
    >
      <div className="sep-card-top">
        <b>{name}</b>
        {row.current && <span className="sep-card-use" title={t("New charts use this. It follows the Lead-in silence setting.")}>{t("In use")}</span>}
      </div>
      {separating ? (
        <div className="sep-card-empty" aria-live="polite">
          <div className="gen-progressbar sm" aria-hidden="true"><i className="indeterminate" /></div>
          <span>{t("Separating stems…")}</span>
        </div>
      ) : row.separated ? (
        <StemLanes rows={rows} levels={levels} />
      ) : (
        <div className="sep-card-empty">
          <b>{t("Not separated yet")}</b>
          <span>{t("Its first chart separates it.")}</span>
        </div>
      )}
      <div className="sep-card-foot">
        <span className={"sep-card-takes" + (row.takes ? "" : " faint")}>{tn(row.takes, "{count} take", "{count} takes")}</span>
        {action && (
          <button
            type="button"
            className="take-action"
            onClick={(e) => {
              e.stopPropagation();
              onSeparate();
            }}
            disabled={busy || !canSeparate}
            tabIndex={showing ? 0 : -1}
            title={
              !canSeparate
                ? t("Choose media first")
                : row.separated
                  ? t("Made before {stems} had its own stem", { stems: missing.map((stem) => t(stem.label)).join(", ") })
                  : undefined
            }
          >
            {action}
          </button>
        )}
      </div>
    </div>
  );
}

function DemucsPanel({ project, showing }) {
  const {
    busy,
    busyAction,
    demucsViewId,
    setDemucsViewId,
    demucsAudition,
    activeDemucsId,
    prepareDemucsSeparation,
    separationLeadIns,
    sourceAudioFile,
    selectedGenerator,
  } = project;
  const [error, setError] = useState("");
  const [separatingKey, setSeparatingKey] = useState("");
  const stemSetId = generatorStemSetId(selectedGenerator);
  const rows = stemRowsFor(stemSetId);
  const separated = separationLeadIns.filter((row) => row.separated);
  const shownId = [demucsViewId, demucsAudition?.id, activeDemucsId]
    .find((id) => id && separated.some((row) => row.artifact.id === id)) || separated[0]?.artifact.id;
  const separatingNow = busyAction === "separating";

  const separate = async (row) => {
    setError("");
    setSeparatingKey(row.key);
    try {
      await prepareDemucsSeparation({
        id: row.artifact?.id || "",
        name: row.artifact?.name || "",
        makeActive: row.current,
        sourceTransform: row.transform,
      });
    } catch (err) {
      setError(err.message || t("Separation failed."));
    } finally {
      setSeparatingKey("");
    }
  };

  return (
    <>
      <div className="sep-list">
        {separationLeadIns.map((row) => (
          <SeparationCard
            key={row.key}
            row={row}
            rows={rows}
            stemSetId={stemSetId}
            onStage={row.artifact?.id === shownId}
            separating={separatingNow && (separatingKey ? separatingKey === row.key : row.current)}
            busy={busy}
            canSeparate={Boolean(sourceAudioFile)}
            showing={showing}
            onView={() => setDemucsViewId(row.artifact.id)}
            onSeparate={() => separate(row)}
          />
        ))}
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

  // Export and Save with nothing assigned show where the final chart is
  // picked: the viewed take (else the newest) scrolls into view, then its
  // E M H X pips and the Final strip pulse.
  const rowRef = useRef(null);
  const cardRefs = useRef(new Map());
  const [nudgedId, setNudgedId] = useState("");
  const nudgeRun = useRef(0);
  useEffect(() => () => { nudgeRun.current += 1; }, []);
  const assignableTakes = takesNewestFirst.filter((v) => v.chart?.text);
  const finalBlocked = busy || !songId || Boolean(finalTimingIssue) || (!finalFilledCount && !assignableTakes.length);
  const showWhereToAssign = () => {
    const viewed = previewMode === "single" && !showingLiveStage ? selectedSingleVersion : null;
    const target = assignableTakes.find((v) => v.id === viewed?.id) || assignableTakes[0];
    if (!target) return;
    project.setStatusMsg(t("Pick E, M, H or X on a take to put it in the final chart."));
    const run = ++nudgeRun.current;
    setNudgedId("");
    const pulse = () => {
      if (run !== nudgeRun.current) return;
      requestAnimationFrame(() => {
        if (run !== nudgeRun.current) return;
        setNudgedId(target.id);
        setTimeout(() => run === nudgeRun.current && setNudgedId(""), 1700);
      });
    };
    const card = cardRefs.current.get(target.id);
    const row = rowRef.current;
    if (!card || !row) return pulse();
    const box = card.getBoundingClientRect();
    const view = row.getBoundingClientRect();
    if (box.left >= view.left - 1 && box.right <= view.right + 1) return pulse();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      row.removeEventListener("scrollend", finish);
      pulse();
    };
    row.addEventListener("scrollend", finish);
    setTimeout(finish, 1200);
    card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    return undefined;
  };
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
            {t("Separation")} <span>{project.separationLeadIns.filter((row) => row.separated).length}</span>
          </button>
        </div>

        {!showingDemucs ? (
          <>
            <div className={"final-strip" + (nudgedId ? " is-nudged" : "")} title={t("Final chart · {count} assigned", { count: finalReadyLabel })}>
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
              onClick={finalFilledCount ? handleSaveFinalToLibrary : showWhereToAssign}
              aria-label={
                savingLibrary
                  ? t("Saving final chart to {library}", { library: GAME_LIBRARY_NAME })
                  : justSavedLibrary
                    ? t("Saved final chart to {library}", { library: GAME_LIBRARY_NAME })
                    : t("Save final chart to {library}", { library: GAME_LIBRARY_NAME })
              }
              disabled={finalBlocked}
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
              onClick={finalFilledCount ? handleExportFinal : showWhereToAssign}
              disabled={finalBlocked}
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
              <span>{t("New charts use")}</span>
              <b>{leadInText(project.separationLeadIns.find((row) => row.current)?.transform.label)}</b>
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
          <div className="takes-row" ref={rowRef}>
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
                  ref={(node) => {
                    if (node) cardRefs.current.set(v.id, node);
                    else cardRefs.current.delete(v.id);
                  }}
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
                    <div className={"take-pips" + (nudgedId === v.id ? " is-nudged" : "")} onClick={(e) => e.stopPropagation()}>
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
          <DemucsPanel project={project} showing={showingDemucs} />
        </div>
      </div>
    </section>
  );
}
