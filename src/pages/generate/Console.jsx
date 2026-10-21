import { useRef, useState } from "react";
import {
  descriptorKnobsForGenerator,
  DESCRIPTOR_KNOB_MAX,
  GENERATION_DIFFICULTIES,
  GENERATION_PRESETS,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import GenerationProgress from "./GenerationProgress.jsx";
import { changedSettingsSummary } from "./MoreSettings.jsx";
import WorkTabs from "./WorkTabs.jsx";

// Fret colors, one per style knob, in lane order.
const KNOB_COLORS = ["var(--fret-g)", "var(--fret-r)", "var(--fret-y)", "var(--fret-b)", "var(--fret-o)"];

// Stops from the bottom: 0 is "auto" (its own bay, not a magnitude), then the
// model's bins 0..6 stacked above it.
const STOPS = DESCRIPTOR_KNOB_MAX + 2;

function knobStop(raw) {
  return raw === "auto" || raw == null ? 0 : Number(raw) + 1;
}

function stopValue(stop) {
  return stop <= 0 ? "auto" : String(Math.min(DESCRIPTOR_KNOB_MAX, stop - 1));
}

// One vertical mini fader. Click a segment to set the level (or drag along
// the column); the bottom bay is auto. Hovering previews where a click lands.
// Arrow keys step it.
function StyleFader({ knob, color, raw, disabled, onChange }) {
  const trackRef = useRef(null);
  const [hoverStop, setHoverStop] = useState(null);
  const stop = knobStop(raw);
  const isAuto = stop === 0;
  const previewing = hoverStop != null && !disabled;

  // The stop whose segment (or the bay) sits nearest the pointer.
  const stopAt = (clientY) => {
    let best = 0;
    let bestDistance = Infinity;
    for (const el of trackRef.current.querySelectorAll("[data-stop]")) {
      const rect = el.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = Number(el.dataset.stop);
      }
    }
    return best;
  };
  const set = (next) => {
    const value = stopValue(next);
    if (value !== (raw ?? "auto")) onChange(value);
  };

  return (
    <div
      className={"style-fader" + (isAuto ? " is-auto" : "")}
      style={{ "--knob-color": color }}
      title={`${knob.name}: ${knob.hint} (${knob.ends[0]} → ${knob.ends[1]}). Auto lets the model choose.`}
    >
      <span className="style-fader-value">{isAuto ? "auto" : raw}</span>
      <div
        ref={trackRef}
        className="style-fader-track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={knob.name}
        aria-valuemin={0}
        aria-valuemax={STOPS - 1}
        aria-valuenow={stop}
        aria-valuetext={isAuto ? "auto" : String(raw)}
        aria-disabled={disabled}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(stopAt(e.clientY));
        }}
        onPointerMove={(e) => {
          if (disabled) return;
          const next = stopAt(e.clientY);
          setHoverStop(next);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) set(next);
        }}
        onPointerLeave={() => setHoverStop(null)}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
          if (e.key === "Home") set(0);
          else if (e.key === "End") set(STOPS - 1);
          else if (step) set(Math.max(0, Math.min(STOPS - 1, stop + step)));
          else return;
          e.preventDefault();
        }}
      >
        <div className={"style-seg-stack" + (isAuto ? " is-auto" : "") + (previewing ? " is-previewing" : "")}>
          {Array.from({ length: STOPS - 1 }, (_, bin) => {
            const on = bin < stop;
            const willBeOn = previewing && bin < hoverStop;
            return (
              <span
                key={bin}
                data-stop={bin + 1}
                className={
                  "style-seg" +
                  (on ? " on" : "") +
                  (previewing && !on && willBeOn ? " is-preview-on" : "") +
                  (previewing && on && !willBeOn ? " is-preview-off" : "")
                }
                aria-hidden="true"
              />
            );
          }).reverse()}
        </div>
        <span data-stop={0} className={"style-bay" + (isAuto ? " on" : "") + (previewing && hoverStop === 0 && !isAuto ? " is-preview" : "")} aria-hidden="true">auto</span>
      </div>
      <span className="style-fader-name">{knob.short || knob.name}</span>
    </div>
  );
}

// The right rail: what to make (model, difficulty), how loose (sampling, style,
// seed), lead-in, then a one-line summary of everything else, which lives in
// the More settings sheet. Generations and final assembly live in the takes
// deck, not here.
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
    selectableGenerators,
    selectGenerator,
    supportedDifficultyIds,
    selectedPreset,
    generationControls,
    usesSourceChartSync,
    setGenerationControls,
    updateGenerationControl,
    updateAdvancedNumberControl,
    applyGenerationPreset,
    advancedSettingsOpen,
    setAdvancedSettingsOpen,
    reusedFrom,
    reusedSettingsMatch,
    randomSeedValue,
    genRun,
    handleGenerate,
    handleStopGenerate,
    sourceAudioFile,
    generatorId,
  } = project;

  const generating = busyAction === "generating";
  const stopping = Boolean(genRun?.stopping);
  const runActive = generating && genRun && !genRun.finishedAt;

  const visibleDifficulties = GENERATION_DIFFICULTIES.filter((option) =>
    supportedDifficultyIds?.includes(option.id)
  );
  const hasKnobs = Boolean(selectedGenerator?.capabilities?.descriptorKnobs);
  const styleKnobs = descriptorKnobsForGenerator(selectedGenerator);
  const allKnobsAuto = styleKnobs.every((knob) => (generationControls[knob.key] ?? "auto") === "auto");
  const generatorChoices = selectableGenerators || [];
  const changed = changedSettingsSummary(project);
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
      <WorkTabs project={project} />
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
                <b>Pick settings</b>
                <small>Model, difficulty, and style.</small>
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
                {generatorChoices.length > 1 ? (
                  <label className="model-plate-picker">
                    <select
                      className="model-plate-name"
                      value={selectedGenerator?.id || ""}
                      onChange={(e) => selectGenerator(e.target.value)}
                      disabled={busy}
                      aria-label="Chart model"
                    >
                      {generatorChoices.map((generator) => (
                        <option key={generator.id} value={generator.id}>
                          {generator.label}
                        </option>
                      ))}
                    </select>
                    <I.chev />
                  </label>
                ) : (
                  <div className="model-plate-name">{selectedGeneratorLabel}</div>
                )}
                {selectedGenerator?.badge && (
                  <span className="model-plate-badge" title={selectedGenerator.description || selectedGenerator.badge}>
                    {selectedGenerator.badge}
                  </span>
                )}
              </div>
              {selectedGenerator?.status === "experimental" && (
                <div className="model-plate-note">Test model. Its takes are tagged {selectedGeneratorLabel}.</div>
              )}
              {selectedGeneratorSetup && !selectedGeneratorSetup.ready && (
                <div className="model-plate-warning">{selectedGeneratorSetup.message}</div>
              )}
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

            <div className={"variant-field generation-field style-field" + (hasKnobs ? "" : " is-off")}>
              <div className="field-line">
                <label>
                  Style <span className="field-aside">auto = model picks</span>
                </label>
                {hasKnobs ? (
                  <button
                    type="button"
                    className="field-link"
                    onClick={() =>
                      setGenerationControls((current) => ({
                        ...current,
                        ...Object.fromEntries(styleKnobs.map((knob) => [knob.key, "auto"])),
                      }))
                    }
                    disabled={busy || allKnobsAuto}
                  >
                    All auto
                  </button>
                ) : (
                  <small>not on this model</small>
                )}
              </div>
              <div className="style-faders" style={{ "--knob-count": styleKnobs.length }}>
                {styleKnobs.map((knob, index) => (
                  <StyleFader
                    key={knob.id}
                    knob={knob}
                    color={KNOB_COLORS[index % KNOB_COLORS.length]}
                    raw={hasKnobs ? generationControls[knob.key] ?? "auto" : "auto"}
                    disabled={busy || !hasKnobs}
                    onChange={(value) => updateGenerationControl(knob.key, value)}
                  />
                ))}
              </div>
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>Seed</label>
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

            <div className="variant-field generation-field lead-in-field">
              <div className="lead-in-label">
                <label>Lead-in silence</label>
                <small>{usesSourceChartSync ? "fixed by the imported chart" : "silence added before the song"}</small>
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

            <button
              type="button"
              className={"more-settings-row" + (advancedSettingsOpen ? " open" : "")}
              onClick={() => setAdvancedSettingsOpen((open) => !open)}
              aria-expanded={advancedSettingsOpen}
            >
              <I.gear />
              <span className="more-settings-text">
                <b>More settings</b>
                <small title={changed.join(" · ")}>{changed.length ? changed.join(" · ") : "Separation, timing, solos, sampling"}</small>
              </span>
              <I.chevRight />
            </button>

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
              <div className={"reused-line" + (reusedFrom ? "" : " is-empty")} aria-live="polite">
                {reusedFrom && (
                  <>
                    <span className="version-badge">{reusedFrom.badge}</span>
                    <span className="reused-name" title={reusedFrom.name}>
                      {reusedSettingsMatch ? "Same settings as " : "Based on "}
                      {reusedFrom.name}
                    </span>
                  </>
                )}
              </div>
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
