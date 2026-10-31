import { useEffect, useRef } from "react";
import {
  DEFAULT_GENERATION_CONTROLS,
  descriptorKnobsForGenerator,
  generatorMarksSolos,
  TIMING_DETECTOR_OPTIONS,
  timingDetectorLabel,
} from "../../data/generationSettings.js";
import { I } from "../../icons.jsx";
import { t } from "../../i18n/index.js";
import { separationName } from "./separationNames.js";

const forceSoloInfo = () => t(
  "Only acts when the model places no solo on its own. It then starts one where it came closest to starting one and charts the rest of the song again from there, so generation takes longer for those songs. A forced solo can be less convincing than one the model found itself.",
);

function sameNumber(value, target) {
  const number = Number(value);
  return !Number.isFinite(number) || Math.abs(number - target) < 0.000001;
}

function separationLabel(artifact) {
  const name = String(artifact?.name || "Default separation").replace(/\s*\([^)]*lead-in[^)]*\)\s*$/i, "").trim();
  const regenerated = name.match(/^regenerated separation\s*(.*)$/i);
  if (regenerated) return regenerated[1] ? t("Remake {number}", { number: regenerated[1].trim() }) : t("Remake");
  return /^default separation$/i.test(name) ? t("Default") : name;
}

function isDefaultSeparation(artifact) {
  return !artifact || separationLabel(artifact) === t("Default");
}

// Short labels for every More-settings value that differs from its default,
// so the console row can show the popover's state without opening it.
export function changedSettingsSummary(project) {
  const {
    generationControls: c,
    selectedPreset,
    selectedGenerator,
    usesSourceChartSync,
    projectDefaultTimingDetector,
    activeDemucsArtifact,
  } = project;
  const items = [];
  if (!isDefaultSeparation(activeDemucsArtifact)) items.push(t("{name} separation", { name: separationLabel(activeDemucsArtifact) }));
  if (projectDefaultTimingDetector && c.timingDetector !== projectDefaultTimingDetector) {
    items.push(timingDetectorLabel(c.timingDetector, { short: true }));
  }
  if (!usesSourceChartSync && c.timingSmoothing === false) items.push(t("Raw beats"));
  if (generatorMarksSolos(selectedGenerator)) {
    if (c.solos === false) items.push(t("No solos"));
    else if (c.forceSolo) items.push(t("Forced solo"));
  }
  if (!sameNumber(c.temperature, selectedPreset.temperature)) items.push(t("Temp {value}", { value: c.temperature }));
  if (!sameNumber(c.topP, selectedPreset.topP)) items.push(t("Top-p {value}", { value: c.topP }));
  const knobsSet = selectedGenerator?.capabilities?.descriptorKnobs
    && descriptorKnobsForGenerator(selectedGenerator).some((knob) => (c[knob.key] ?? "auto") !== "auto");
  if (knobsSet && !sameNumber(c.guidanceScale, Number(DEFAULT_GENERATION_CONTROLS.guidanceScale))) {
    items.push(t("Strength {value}", { value: c.guidanceScale }));
  }
  return items;
}

function Toggle({ on, onClick, disabled }) {
  return (
    <button
      type="button"
      className={"model-switch" + (on ? " on" : "")}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
    >
      <span className="model-switch-knob" aria-hidden="true" />
    </button>
  );
}

function Row({ label, hint, info, children, disabled }) {
  return (
    <div className={"ms-row" + (disabled ? " is-off" : "")}>
      <div className="ms-row-label">
        <b>
          {label}
          {info && (
            <i className="ms-info" title={info} aria-label={info} role="img">
              <I.info />
            </i>
          )}
        </b>
        <small>{hint}</small>
      </div>
      <div className="ms-row-control">{children}</div>
    </div>
  );
}

// Everything that isn't on the console itself: separation, timing, solos and
// raw sampling. A compact popover hanging off the console's left edge; it
// keeps one fixed layout, so settings a model doesn't have are disabled, not
// hidden. Esc or a click outside closes it.
export default function MoreSettings({ project }) {
  const {
    busy,
    generationControls: c,
    setGenerationControls,
    updateGenerationControl,
    updateAdvancedNumberControl,
    selectedGenerator,
    selectedPreset,
    hasSourceChartSync,
    usesSourceChartSync,
    projectDefaultTimingDetector,
    activeDemucsArtifact,
    setDeckTab,
    setAdvancedSettingsOpen,
  } = project;
  const panelRef = useRef(null);

  const close = () => setAdvancedSettingsOpen(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setAdvancedSettingsOpen(false);
    };
    const onPointer = (e) => {
      if (panelRef.current?.contains(e.target) || e.target.closest?.(".more-settings-row")) return;
      setAdvancedSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [setAdvancedSettingsOpen]);

  const marksSolos = generatorMarksSolos(selectedGenerator);
  const hasKnobs = Boolean(selectedGenerator?.capabilities?.descriptorKnobs);
  const knobsSet = hasKnobs
    && descriptorKnobsForGenerator(selectedGenerator).some((knob) => (c[knob.key] ?? "auto") !== "auto");
  const timingOptions = TIMING_DETECTOR_OPTIONS.filter((option) => !option.sourceChart || hasSourceChartSync);
  const smoothingOn = c.timingSmoothing !== false;
  const changed = changedSettingsSummary(project);

  const resetAll = () => {
    setGenerationControls((current) => ({
      ...current,
      temperature: selectedPreset.temperature.toFixed(2),
      topP: selectedPreset.topP.toFixed(2),
      guidanceScale: DEFAULT_GENERATION_CONTROLS.guidanceScale,
      timingDetector: projectDefaultTimingDetector,
      timingSmoothing: DEFAULT_GENERATION_CONTROLS.timingSmoothing,
      solos: DEFAULT_GENERATION_CONTROLS.solos,
      forceSolo: DEFAULT_GENERATION_CONTROLS.forceSolo,
    }));
  };

  return (
    <section ref={panelRef} className="more-settings" role="dialog" aria-label={t("More settings")}>
      <header className="ms-head">
        <h2>{t("More settings")}</h2>
        <button type="button" className="ms-reset" onClick={resetAll} disabled={busy || !changed.length}>
          {t("Reset")}
        </button>
        <button type="button" className="ms-close" onClick={close} aria-label={t("Close more settings")} title={t("Close (Esc)")}>
          <I.plus />
        </button>
      </header>

      <div className="ms-body">
        <div className="ms-group">
          <h3>{t("Audio separation")}</h3>
          <p className="ms-group-note">
            {t("Splits the song so the model hears the guitar on its own. If a chart misses parts, try another one.")}
          </p>
          <Row label={t("New takes use")} hint={separationName(activeDemucsArtifact?.name)}>
            <button
              type="button"
              className="ms-link-btn"
              onClick={() => {
                close();
                setDeckTab("demucs");
              }}
              disabled={busy}
            >
              {separationLabel(activeDemucsArtifact)} <I.chevRight />
            </button>
          </Row>
        </div>

        <div className="ms-group">
          <h3>{t("Timing")}</h3>
          <Row label={t("Beat map")} hint={usesSourceChartSync ? t("Taken from the imported chart") : t("Found from the audio")}>
            <select
              value={c.timingDetector}
              onChange={(e) => updateGenerationControl("timingDetector", e.target.value)}
              disabled={busy || timingOptions.length < 2}
            >
              {timingOptions.map((option) => (
                <option key={option.id} value={option.id}>{t(option.name)}</option>
              ))}
            </select>
          </Row>
          <Row
            label={t("Smoothing")}
            hint={usesSourceChartSync ? t("The imported chart is already steady") : t("Steadies the beat spacing")}
            disabled={usesSourceChartSync}
          >
            <Toggle
              on={smoothingOn && !usesSourceChartSync}
              onClick={() => updateGenerationControl("timingSmoothing", !smoothingOn)}
              disabled={busy || usesSourceChartSync}
            />
          </Row>
        </div>

        <div className="ms-group">
          <h3>{t("Solos")}</h3>
          <Row
            label={t("Mark solos")}
            hint={marksSolos ? t("Where the model hears one") : t("This model doesn't mark solos")}
            disabled={!marksSolos}
          >
            <Toggle
              on={marksSolos && c.solos !== false}
              onClick={() => updateGenerationControl("solos", c.solos === false)}
              disabled={busy || !marksSolos}
            />
          </Row>
          <Row
            label={t("Force a solo")}
            hint={t("Adds one if the model found none")}
            info={forceSoloInfo()}
            disabled={!marksSolos || c.solos === false}
          >
            <Toggle
              on={marksSolos && c.solos !== false && Boolean(c.forceSolo)}
              onClick={() => updateGenerationControl("forceSolo", !c.forceSolo)}
              disabled={busy || !marksSolos || c.solos === false}
            />
          </Row>
        </div>

        <div className="ms-group">
          <h3>{t("Sampling")}</h3>
          <Row label={t("Temperature")} hint={t("Higher is more varied")}>
            <input
              inputMode="decimal"
              value={c.temperature}
              disabled={busy}
              onChange={(e) => updateAdvancedNumberControl("temperature", e.target.value)}
              aria-label={t("Temperature")}
            />
          </Row>
          <Row label="Top-p" hint={t("Lower is safer")}>
            <input
              inputMode="decimal"
              value={c.topP}
              disabled={busy}
              onChange={(e) => updateAdvancedNumberControl("topP", e.target.value)}
              aria-label="Top-p"
            />
          </Row>
          <Row
            label={t("Style strength")}
            hint={!hasKnobs ? t("This model has no style") : knobsSet ? t("How hard style is pushed") : t("Set a style first")}
            disabled={!knobsSet}
          >
            <input
              inputMode="decimal"
              value={c.guidanceScale}
              disabled={busy || !knobsSet}
              onChange={(e) => updateAdvancedNumberControl("guidanceScale", e.target.value)}
              aria-label={t("Style strength")}
            />
          </Row>
        </div>
      </div>
    </section>
  );
}
