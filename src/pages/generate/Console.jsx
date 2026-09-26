import {
  DESCRIPTOR_KNOBS,
  DESCRIPTOR_KNOB_MAX,
  GENERATION_DIFFICULTIES,
  GENERATION_PRESETS,
  TIMING_DETECTOR_OPTIONS,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import GenerationProgress from "./GenerationProgress.jsx";
import EditorConsole from "./edit/EditorConsole.jsx";

// The slider carries one stop below bin 0 for "auto" — a fenced bay, not a
// magnitude. Bin 7 is what the model actually calls auto; we park it on the
// left so the 0..6 run stays a plain low-to-high scale.
const AUTO_STOP = -1;

function sourceVariantTag(artifact) {
  const ms = Number(artifact?.sourceTransform?.leadInSilenceMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  return `+${Number.isInteger(seconds) ? seconds : seconds.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "")}s`;
}

function activeSeparationLabel(artifact) {
  const rawName = String(artifact?.name || "Default separation").replace(/\s*\([^)]*lead-in[^)]*\)\s*$/i, "").trim();
  const variant = sourceVariantTag(artifact);
  const suffix = variant === "0s" ? "" : ` · ${variant}`;
  if (/^default separation$/i.test(rawName)) return `Default${suffix}`;
  const regenerated = rawName.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return `Regen${regenerated[1] ? ` ${regenerated[1].trim()}` : ""}${suffix}`;
  return `${rawName}${suffix}`;
}

// The right rail is a true "channel strip": model plate, difficulty, sampling,
// seed, advanced, GENERATE — and the live progress panel while a run is going.
// Generations and final assembly live in the takes deck, not here.
export default function Console({ project }) {
  const {
    hasMedia,
    busy,
    busyAction,
    statusMsg,
    engineError,
    selectedGenerator,
    selectedGeneratorSetup,
    selectedGeneratorLabel,
    supportedDifficultyIds,
    selectedPreset,
    currentGeneration,
    resolvedSettings,
    generationControls,
    hasSourceChartSync,
    usesSourceChartSync,
    setGenerationControls,
    updateGenerationControl,
    updateAdvancedNumberControl,
    applyGenerationPreset,
    resetCurrentGenerationPreset,
    advancedSettingsOpen,
    setAdvancedSettingsOpen,
    randomSeedValue,
    genRun,
    handleGenerate,
    handleStopGenerate,
    sourceAudioFile,
    generatorId,
    activeDemucsArtifact,
    setDeckTab,
    deckTab,
  } = project;

  const generating = busyAction === "generating";
  const stopping = Boolean(genRun?.stopping);
  const runActive = generating && genRun && !genRun.finishedAt;

  if (deckTab === "edit") {
    return (
      <aside className="console-rail">
        <EditorConsole project={project} />
        {(engineError || (statusMsg && busyAction !== "generating")) && (
          <div className="rail-toast">{statusMsg || engineError}</div>
        )}
      </aside>
    );
  }

  const visibleDifficulties = GENERATION_DIFFICULTIES.filter((option) =>
    supportedDifficultyIds?.includes(option.id)
  );
  const timingOptions = TIMING_DETECTOR_OPTIONS.filter((option) => !option.sourceChart || hasSourceChartSync);
  const smoothingEnabled = Boolean(resolvedSettings.timingSmoothing?.enabled);
  const generateDisabledReason = runActive
    ? stopping
      ? "Stopping the current generation."
      : "Stop the current generation."
    : busy
      ? "Wait for the current generation operation to finish."
      : !sourceAudioFile
        ? "Choose a media file first."
        : !generatorId
          ? "The chart generation engine is unavailable."
          : selectedGeneratorSetup?.ready === false
            ? selectedGeneratorSetup.message || "Open Setup to install the chart generation package."
            : "";

  return (
    <aside className="console-rail">
      <section className="rail-sec">
        {!hasMedia ? (
          <ol className="console-steps">
            <li className="console-step">
              <span className="step-num">1</span>
              <div>
                <b>Add media</b>
                <small>Drop a song or video on the stage.</small>
              </div>
            </li>
            <li className="console-step">
              <span className="step-num">2</span>
              <div>
                <b>Tune the console</b>
                <small>Pick difficulty, sampling, and seed.</small>
              </div>
            </li>
            <li className="console-step">
              <span className="step-num">3</span>
              <div>
                <b>Generate</b>
                <small>Takes land in the deck below the preview.</small>
              </div>
            </li>
          </ol>
        ) : (
          <>
            <div className="model-plate">
              <div className="model-plate-top">
                <div className="model-plate-name">{selectedGeneratorLabel}</div>
              </div>
              {selectedGeneratorSetup && !selectedGeneratorSetup.ready && (
                <div className="model-plate-warning">{selectedGeneratorSetup.message}</div>
              )}
            </div>

            <button
              type="button"
              className="source-prep-row"
              onClick={() => setDeckTab("demucs")}
              disabled={busy}
              title="Choose which audio separation new charts use"
            >
              <span>
                <small>AUDIO SEPARATION</small>
                <b title={activeDemucsArtifact?.name || "Default separation"}>{activeSeparationLabel(activeDemucsArtifact)}</b>
              </span>
              <em>Choose</em>
            </button>

            <div className="variant-field generation-field lead-in-field">
              <div className="lead-in-label">
                <label>Lead-in silence</label>
                <small>reruns timing and separation</small>
              </div>
              <div className="lead-in-row">
                <span>sec</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="30"
                  step="0.5"
                  value={generationControls.leadInSilenceSeconds ?? "0"}
                  placeholder="0"
                  disabled={busy || usesSourceChartSync}
                  onChange={(e) => updateAdvancedNumberControl("leadInSilenceSeconds", e.target.value)}
                  aria-label="Lead-in silence seconds"
                />
              </div>
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>Difficulty</label>
                {visibleDifficulties.length === 1 && <small>fixed by this model</small>}
              </div>
              <div className="difficulty-segments" role="radiogroup" aria-label="Chart difficulty">
                {visibleDifficulties.map((option) => (
                  <button
                    key={option.id}
                    className={
                      `diff-seg tone-${option.tone}` +
                      (generationControls.difficulty === option.id ? " active" : "")
                    }
                    onClick={() => updateGenerationControl("difficulty", option.id)}
                    disabled={busy}
                    role="radio"
                    aria-checked={generationControls.difficulty === option.id}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>Sampling</label>
                <small>{selectedPreset.summary}</small>
              </div>
              <div className="preset-grid">
                {GENERATION_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={generationControls.presetId === preset.id ? "active" : ""}
                    onClick={() => applyGenerationPreset(preset.id)}
                    disabled={busy}
                  >
                    <b>{preset.name}</b>
                  </button>
                ))}
              </div>
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>Variation seed</label>
              </div>
              <div className="seed-row">
                <div className="seed-mode">
                  <button
                    className={generationControls.seedMode === "random" ? "active" : ""}
                    onClick={() => setGenerationControls((current) => ({ ...current, seedMode: "random", seed: "" }))}
                    disabled={busy}
                  >
                    Random
                  </button>
                  <button
                    className={generationControls.seedMode === "fixed" ? "active" : ""}
                    onClick={() =>
                      setGenerationControls((current) => ({
                        ...current,
                        seedMode: "fixed",
                        seed: current.seed || randomSeedValue(),
                      }))
                    }
                    disabled={busy}
                  >
                    Fixed
                  </button>
                </div>
                <input
                  inputMode="numeric"
                  value={generationControls.seed}
                  placeholder={generationControls.seedMode === "random" ? "random" : "Seed"}
                  disabled={busy || generationControls.seedMode === "random"}
                  onChange={(e) => updateGenerationControl("seed", e.target.value.replace(/[^\d-]/g, ""))}
                  aria-label="Variation seed"
                />
                <button
                  className="seed-spark"
                  onClick={() =>
                    setGenerationControls((current) => ({
                      ...current,
                      seedMode: "fixed",
                      seed: randomSeedValue(),
                    }))
                  }
                  disabled={busy}
                  title="Pick fixed seed"
                  aria-label="Pick fixed seed"
                >
                  <I.spark />
                </button>
              </div>
            </div>

            <button
              type="button"
              className={"advanced-toggle-row" + (advancedSettingsOpen ? " open" : "")}
              onClick={() => setAdvancedSettingsOpen((open) => !open)}
              aria-expanded={advancedSettingsOpen}
            >
              <I.gear />
              <span className="advanced-toggle-label">ADVANCED</span>
              <span className="advanced-recipe">
                {currentGeneration.modified ? "modified" : `${selectedPreset.name} recipe`}
              </span>
              <span className="advanced-toggle-state">
                {advancedSettingsOpen ? "Hide" : "Show"}
                <I.chev />
              </span>
            </button>

            {advancedSettingsOpen && (
              <div className="advanced-engine-body inline">
                <div className="advanced-inline-bar">
                  <span className="advanced-recipe">
                    {currentGeneration.modified ? "modified" : `${selectedPreset.name} recipe`}
                  </span>
                  <button className="advanced-reset" onClick={resetCurrentGenerationPreset} disabled={busy}>
                    Reset
                  </button>
                </div>

                {selectedGenerator?.capabilities?.descriptorKnobs && (
                  <div className="engine-group knob-group">
                    <div className="engine-group-title">Style</div>
                    <p className="knob-group-note">Auto lets the model decide. Drag a knob off auto to steer it.</p>
                    {DESCRIPTOR_KNOBS.map((knob) => {
                      const raw = generationControls[knob.key] ?? "auto";
                      const isAuto = raw === "auto";
                      // Auto parks in a fenced-off bay one stop left of bin 0. It is a
                      // separate descriptor category, not a magnitude, so it must never
                      // land on the 0..6 run — least of all at its midpoint.
                      const value = isAuto ? AUTO_STOP : Number(raw);
                      const stops = DESCRIPTOR_KNOB_MAX - AUTO_STOP; // 7 gaps, 8 stops
                      return (
                        <div className={"knob-row" + (isAuto ? " is-auto" : "")} key={knob.id}>
                          <div className="knob-head">
                            <span className="knob-name">{knob.name}</span>
                            <span className="knob-hint">{knob.hint}</span>
                            <button
                              type="button"
                              className={"knob-auto" + (isAuto ? " active" : "")}
                              onClick={() => updateGenerationControl(knob.key, "auto")}
                              disabled={busy}
                              aria-pressed={isAuto}
                            >
                              Auto
                            </button>
                          </div>
                          <div className="knob-slider">
                            <div
                              className="knob-rail"
                              style={{
                                "--knob-p": (value - AUTO_STOP) / stops,
                                "--knob-p0": 1 / stops,
                              }}
                            >
                              <span className="knob-bay" aria-hidden="true" />
                              {Array.from({ length: DESCRIPTOR_KNOB_MAX + 1 }, (_, bin) => (
                                <span
                                  key={bin}
                                  className="knob-tick"
                                  style={{ "--knob-tp": (bin + 1) / stops }}
                                  aria-hidden="true"
                                />
                              ))}
                              {!isAuto && <span className="knob-fill" aria-hidden="true" />}
                              <input
                                type="range"
                                min={AUTO_STOP}
                                max={DESCRIPTOR_KNOB_MAX}
                                step="1"
                                value={value}
                                disabled={busy}
                                onChange={(e) => {
                                  const next = Number(e.target.value);
                                  updateGenerationControl(
                                    knob.key,
                                    next === AUTO_STOP ? "auto" : String(next)
                                  );
                                }}
                                aria-label={knob.name}
                                aria-valuetext={isAuto ? "auto" : String(value)}
                              />
                            </div>
                            <span className={"knob-value" + (isAuto ? " is-auto" : "")}>
                              {isAuto ? "auto" : value}
                            </span>
                          </div>
                          <div className="knob-captions" aria-hidden="true">
                            <span className="knob-cap-auto">auto</span>
                            <span className="knob-end">{knob.ends[1]}</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className={"knob-guidance" + (DESCRIPTOR_KNOBS.every((knob) => generationControls[knob.key] === "auto") ? " dim" : "")}>
                      <span>GUIDANCE</span>
                      <input
                        inputMode="decimal"
                        value={generationControls.guidanceScale}
                        disabled={busy}
                        onChange={(e) => updateAdvancedNumberControl("guidanceScale", e.target.value)}
                        aria-label="Guidance scale"
                      />
                      <small>
                        {DESCRIPTOR_KNOBS.every((knob) => generationControls[knob.key] === "auto")
                          ? "set a knob to enable"
                          : "pushes set knobs harder"}
                      </small>
                    </div>
                  </div>
                )}

                <div className="engine-group">
                  <div className="engine-group-title">Sampling</div>
                  <label className="engine-setting">
                    <span>TEMPERATURE</span>
                    <input
                      inputMode="decimal"
                      value={generationControls.temperature}
                      disabled={busy}
                      onChange={(e) => updateAdvancedNumberControl("temperature", e.target.value)}
                    />
                    <small>higher = more variation</small>
                  </label>
                </div>

                <div className="engine-group">
                  <div className="engine-group-title">Nucleus</div>
                  <label className="engine-setting">
                    <span>TOP_P</span>
                    <input
                      inputMode="decimal"
                      value={generationControls.topP}
                      disabled={busy}
                      onChange={(e) => updateAdvancedNumberControl("topP", e.target.value)}
                    />
                    <small>lower = safer picks</small>
                  </label>
                </div>

                <div className="engine-group timing-group">
                  <div className="engine-group-title">Export</div>
                  {selectedGenerator?.capabilities?.sustains === "never-strip" ? null : (
                    <label className="engine-setting">
                      <span>SUSTAINS</span>
                      <button
                        type="button"
                        className={"engine-flag" + (generationControls.stripSustains ? "" : " on")}
                        onClick={() =>
                          setGenerationControls((current) => ({
                            ...current,
                            stripSustains: !current.stripSustains,
                          }))
                        }
                        disabled={busy}
                      >
                        {generationControls.stripSustains ? "Stripped" : "Kept"}
                      </button>
                      <small>keep or strip long note tails</small>
                    </label>
                  )}
                  <label className="engine-setting">
                    <span>DETECTOR</span>
                    <select
                      value={generationControls.timingDetector}
                      onChange={(e) => updateGenerationControl("timingDetector", e.target.value)}
                      disabled={busy}
                    >
                      {timingOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                      ))}
                    </select>
                    <small>{usesSourceChartSync ? "uses imported notes.chart SyncTrack" : resolvedSettings.timingRaw ? "raw Beat-This detections" : "refined detector grid"}</small>
                  </label>
                  <label className="engine-setting">
                    <span>SMOOTHING</span>
                    <button
                      type="button"
                      className={"engine-flag" + (smoothingEnabled ? " on" : "")}
                      onClick={() => updateGenerationControl("timingSmoothing", !smoothingEnabled)}
                      disabled={busy || usesSourceChartSync}
                    >
                      {smoothingEnabled ? "On" : "Off"}
                    </button>
                    <small>
                      {usesSourceChartSync
                        ? "source chart timing is already fixed"
                        : smoothingEnabled
                          ? "cleans gaps and steadies beat spacing"
                          : "uses the raw detected beat grid"}
                    </small>
                  </label>
                </div>
              </div>
            )}

            <div className="generation-actions">
              <button
                className={
                  "gen-cta" +
                  (!sourceAudioFile && !runActive ? " needs-input" : "") +
                  (runActive && stopping ? " is-busy" : "")
                }
                onClick={runActive ? handleStopGenerate : handleGenerate}
                disabled={
                  runActive
                    ? stopping
                    : busy || !sourceAudioFile || !generatorId || selectedGeneratorSetup?.ready === false
                }
                aria-describedby="generate-cta-reason"
                title={generateDisabledReason || "Generate a chart"}
              >
                {!generatorId && !runActive ? (
                  "ENGINE UNAVAILABLE"
                ) : selectedGeneratorSetup?.ready === false && !runActive ? (
                  "SETUP REQUIRED"
                ) : stopping ? (
                  <>
                    <span className="cta-spinner" aria-hidden="true" /> STOPPING…
                  </>
                ) : runActive ? (
                  "STOP"
                ) : (
                  <>
                    GENERATE CHART <I.boltFill />
                  </>
                )}
              </button>
              <span id="generate-cta-reason" className="sr-only">{generateDisabledReason}</span>
            </div>
          </>
        )}
      </section>

      {genRun && (
        <section className="rail-sec">
          <GenerationProgress run={genRun} />
          {project.canRetryUsingCpu && (
            <div className="rail-toast" role="alert">
              <p>Hardware acceleration failed. Try the same song and options using CPU.</p>
              <button type="button" className="btn" onClick={project.handleRetryUsingCpu}>Retry using CPU</button>
            </div>
          )}
        </section>
      )}

      {(engineError || (statusMsg && busyAction !== "generating")) && (
        <div className="rail-toast">{statusMsg || engineError}</div>
      )}
    </aside>
  );
}
