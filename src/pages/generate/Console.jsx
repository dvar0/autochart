import {
  descriptorKnobsForGenerator,
  GENERATION_DIFFICULTIES,
  GENERATION_PRESETS,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import ProgressRing from "../../components/ProgressRing.jsx";
import GenerationProgress from "./GenerationProgress.jsx";
import StyleFader, { KNOB_COLORS } from "./StyleFader.jsx";
import { changedSettingsSummary } from "./MoreSettings.jsx";
import WorkTabs from "./WorkTabs.jsx";
import { BETA_MODELS, MODEL_FAMILIES, isBetaGenerator } from "../../data/modelFamilies.js";
import { t } from "../../i18n/index.js";

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
    modelDownload,
    downloadSelectedModel,
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
    liteOffer,
    liteSwitch,
    switchToLite,
    keepSeparating,
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
  // The browser version downloads a model the first time it runs; Generate
  // says so, with the size, until it's in the browser.
  const pendingDownloadMb = selectedGeneratorSetup?.ready && selectedGeneratorSetup.downloaded === false
    ? (MODEL_FAMILIES.find((family) => family.generatorId === generatorId
      || family.id === BETA_MODELS.find((model) => model.generatorId === generatorId)?.familyId)?.downloadMb || 0)
    : null;
  // ...and when it won't fit on this device, says that instead and holds
  // Generate until there's room (Settings can remove models).
  const spaceShort = selectedGeneratorSetup?.spaceShort || null;
  const generateDisabledReason = runActive
    ? stopping
      ? t("Stopping the current generation.")
      : t("Stop the current generation.")
    : busy
      ? t("Wait for the current generation operation to finish.")
      : modelDownload
        ? modelDownload.waiting ? t("Another model is downloading.") : ""
      : !sourceAudioFile
        ? t("Choose a media file first.")
        : !generatorId
          ? t("The chart generation engine is unavailable.")
          : selectedGeneratorSetup?.ready === false
            ? selectedGeneratorSetup.message || t("Download the model in Settings.")
            : spaceShort
              ? t("Not enough space on this device: the model needs {needed} MB, about {free} MB is free.", { needed: spaceShort.neededMb, free: spaceShort.freeMb })
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
                <b>{t("Add media")}</b>
                <small>{t("Drop a song, video or song folder on the stage.")}</small>
              </div>
            </li>
            <li className="console-step">
              <span className="step-num">2</span>
              <div>
                <b>{t("Pick settings")}</b>
                <small>{t("Model, difficulty, and style.")}</small>
              </div>
            </li>
            <li className="console-step">
              <span className="step-num">3</span>
              <div>
                <b>{t("Generate")}</b>
                <small>{t("Takes appear below.")}</small>
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
                      aria-label={t("Chart model")}
                    >
                      {generatorChoices.map((generator) => (
                        <option key={generator.id} value={generator.id}>
                          {generator.label}{isBetaGenerator(generator.id) ? ` · ${t("Beta")}` : ""}
                        </option>
                      ))}
                    </select>
                    <I.chev />
                  </label>
                ) : (
                  <div className="model-plate-name">{selectedGeneratorLabel}</div>
                )}
              </div>
              {selectedGeneratorSetup && !selectedGeneratorSetup.ready && (
                <div className="model-plate-warning">{modelDownload?.message || selectedGeneratorSetup.message}</div>
              )}
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>{t("Difficulty")}</label>
                {visibleDifficulties.length === 1 && <small>{t("Set by this model")}</small>}
              </div>
              <div className="difficulty-segments" role="radiogroup" aria-label={t("Chart difficulty")}>
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
                    {t(option.name)}
                  </button>
                ))}
              </div>
            </div>

            <div className="variant-field generation-field">
              <div className="field-line">
                <label>{t("Sampling")}</label>
                <small>{t(selectedPreset.summary)}</small>
              </div>
              <div className="preset-grid">
                {GENERATION_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className={generationControls.presetId === preset.id ? "active" : ""}
                    onClick={() => applyGenerationPreset(preset.id)}
                    disabled={busy}
                  >
                    <b>{t(preset.name)}</b>
                  </button>
                ))}
              </div>
            </div>

            <div className={"variant-field generation-field style-field" + (hasKnobs ? "" : " is-off")}>
              <div className="field-line">
                <label>{t("Style")}</label>
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
                    {t("All auto")}
                  </button>
                ) : (
                  <small>{t("Not on this model")}</small>
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
                <label>{t("Seed")}</label>
              </div>
              <div className="seed-row">
                <div className="seed-mode">
                  <button
                    className={generationControls.seedMode === "random" ? "active" : ""}
                    onClick={() => setGenerationControls((current) => ({ ...current, seedMode: "random", seed: "" }))}
                    disabled={busy}
                  >
                    {t("Random")}
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
                    {t("Fixed")}
                  </button>
                </div>
                <input
                  inputMode="numeric"
                  value={generationControls.seed}
                  placeholder={generationControls.seedMode === "random" ? t("random") : t("Seed")}
                  disabled={busy || generationControls.seedMode === "random"}
                  onChange={(e) => updateGenerationControl("seed", e.target.value.replace(/[^\d-]/g, ""))}
                  aria-label={t("Variation seed")}
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
                  title={t("Pick fixed seed")}
                  aria-label={t("Pick fixed seed")}
                >
                  <I.spark />
                </button>
              </div>
            </div>

            <div className="variant-field generation-field lead-in-field">
              <div className="lead-in-label">
                <label>{t("Lead-in silence")}</label>
                <small>{usesSourceChartSync ? t("Set by the imported chart") : t("Added before the song")}</small>
              </div>
              <div className="lead-in-row">
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
                  aria-label={t("Lead-in silence seconds")}
                />
                <span>s</span>
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
                <b>{t("More settings")}</b>
                <small title={changed.join(" · ")}>{changed.length ? changed.join(" · ") : t("Separation, timing, solos, sampling")}</small>
              </span>
              <I.chevRight />
            </button>

            <div className="generation-actions">
              <button
                className={
                  "gen-cta" +
                  (!sourceAudioFile && !runActive && !modelDownload ? " needs-input" : "") +
                  (runActive ? " is-stop" : "")
                }
                onClick={runActive ? handleStopGenerate : modelDownload ? downloadSelectedModel : handleGenerate}
                disabled={
                  runActive
                    ? stopping
                    : modelDownload
                      ? busy || modelDownload.installing || modelDownload.waiting
                      : busy || !sourceAudioFile || !generatorId || selectedGeneratorSetup?.ready === false || Boolean(spaceShort)
                }
                aria-describedby="generate-cta-reason"
                title={generateDisabledReason || (modelDownload ? modelDownload.action : t("Generate a chart"))}
              >
                {!generatorId && !runActive ? (
                  t("Engine unavailable")
                ) : modelDownload?.installing && !runActive ? (
                  <>
                    <ProgressRing value={modelDownload.percent} /> {modelDownload.percent != null ? t("Downloading {percent}%", { percent: modelDownload.percent }) : t("Downloading…")}
                  </>
                ) : modelDownload && !runActive ? (
                  <>
                    <I.download /> {modelDownload.action}{modelDownload.size ? ` · ${modelDownload.size}` : ""}
                  </>
                ) : selectedGeneratorSetup?.ready === false && !runActive ? (
                  t("Setup required")
                ) : stopping ? (
                  <>
                    <span className="cta-spinner" aria-hidden="true" /> {t("Stopping…")}
                  </>
                ) : runActive ? (
                  <>
                    <I.close /> {t("Stop")}
                  </>
                ) : pendingDownloadMb != null ? (
                  <>
                    <I.boltFill /> {t("Download and generate")}{pendingDownloadMb ? ` · ${pendingDownloadMb} MB` : ""}
                  </>
                ) : (
                  <>
                    <I.boltFill /> {t("Generate chart")}
                  </>
                )}
              </button>
              <span id="generate-cta-reason" className="sr-only">{generateDisabledReason}</span>
              <div className={"reused-line" + (reusedFrom || spaceShort ? "" : " is-empty")} aria-live="polite">
                {!reusedFrom && spaceShort && !runActive && (
                  <span className="reused-name is-warn" title={generateDisabledReason}>
                    <I.download /> {t("Needs {needed} MB, about {free} MB free. Remove models in Settings.", { needed: spaceShort.neededMb, free: spaceShort.freeMb })}
                  </span>
                )}
                {reusedFrom && (
                  <>
                    <span className="version-badge">{reusedFrom.badge}</span>
                    <span className="reused-name" title={reusedFrom.name}>
                      {reusedSettingsMatch
                        ? t("Same settings as {take}", { take: reusedFrom.name })
                        : t("Based on {take}", { take: reusedFrom.name })}
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
          <GenerationProgress
            run={genRun}
            liteOffer={liteOffer}
            liteSwitch={liteSwitch}
            onSwitchToLite={switchToLite}
            onKeepSeparating={keepSeparating}
          />
          {project.canRetryUsingCpu && (
            <div className="rail-toast" role="alert">
              <p>{t("Hardware acceleration failed. Try the same song and options using CPU.")}</p>
              <button type="button" className="btn" onClick={project.handleRetryUsingCpu}>{t("Retry using CPU")}</button>
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
